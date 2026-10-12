targetScope = 'resourceGroup'

@description('Azure region for Container Apps and Key Vault resources.')
param location string = resourceGroup().location
@description('Lowercase prefix used for Container Apps, identities, and Key Vault naming.')
param namePrefix string = 'shop'
@description('Name of an existing Azure Container Registry in this resource group.')
param registryName string
@description('Build-tagged image names in the existing registry.')
param apiImage string
param bffImage string
param webImage string

@secure()
@description('TLS-enabled PostgreSQL JDBC URL without credentials.')
param databaseUrl string
param databaseUsername string
@secure()
param databasePassword string
param redisHost string
param redisPort int = 6380
@secure()
param redisPassword string
@secure()
@description('TLS Redis URL consumed by Fastify, e.g. rediss://:password@host:6380.')
param bffRedisUrl string
@secure()
param jwtSecret string
@secure()
param apiClientsJson string
@description('Kafka-compatible broker bootstrap endpoint.')
param kafkaBootstrapServers string
param kafkaSecurityProtocol string = 'SASL_SSL'
param kafkaSaslMechanism string = 'PLAIN'
@secure()
param kafkaSaslJaasConfig string
param mailHost string
param mailPort int = 587
param mailUsername string = ''
param mailFrom string = 'no-reply@example.com'
param mailAuth bool = true
param mailStartTls bool = true
@secure()
param mailPassword string
@description('Comma-separated extra browser origins, if any. Same-origin storefront access is included automatically.')
param additionalAllowedOrigins string = ''

var suffix = uniqueString(resourceGroup().id)
var shortPrefix = take(toLower(replace(namePrefix, '-', '')), 10)
var wafName = take(toLower(replace(namePrefix, '-', '')), 64)
var apiAppName = '${namePrefix}-api'
var bffAppName = '${namePrefix}-bff'
var webAppName = '${namePrefix}-web'
var environmentName = '${namePrefix}-env'
var registryServer = '${registryName}.azurecr.io'
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var keyVaultName = take('${shortPrefix}kv${suffix}', 24)

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource logWorkspace 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: '${namePrefix}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    features: { enableLogAccessUsingOnlyResourcePermissions: true }
  }
}

resource acaEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logWorkspace.properties.customerId
        sharedKey: logWorkspace.listKeys().primarySharedKey
      }
    }
  }
}

resource apiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-api-identity'
  location: location
}

resource imagePullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-image-pull'
  location: location
}

resource acrPullAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, imagePullIdentity.id, acrPullRoleId)
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: imagePullIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    publicNetworkAccess: 'Enabled'
  }
}

resource keyVaultSecretUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, apiIdentity.id, '4633458b-17de-408a-b874-0445c86b69e6')
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '4633458b-17de-408a-b874-0445c86b69e6'
    )
    principalId: apiIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource databasePasswordSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'database-password'
  properties: { value: databasePassword }
}
resource jwtSecretValue 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'jwt-secret'
  properties: { value: jwtSecret }
}
resource redisPasswordSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'redis-password'
  properties: { value: redisPassword }
}
resource mailPasswordSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'mail-password'
  properties: { value: mailPassword }
}
resource apiClientsSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'api-clients-json'
  properties: { value: apiClientsJson }
}
resource kafkaJaasSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'kafka-sasl-jaas-config'
  properties: { value: kafkaSaslJaasConfig }
}

resource frontendDoor 'Microsoft.Cdn/profiles@2024-02-01' = {
  name: '${namePrefix}-cdn'
  location: 'global'
  sku: { name: 'Premium_AzureFrontDoor' }
  properties: {}
}

resource frontendEndpoint 'Microsoft.Cdn/profiles/afdEndpoints@2024-02-01' = {
  parent: frontendDoor
  name: 'store'
  location: 'global'
  properties: { enabledState: 'Enabled' }
}

resource storefrontOriginGroup 'Microsoft.Cdn/profiles/originGroups@2024-02-01' = {
  parent: frontendDoor
  name: 'storefront'
  properties: {
    loadBalancingSettings: {
      sampleSize: 4
      successfulSamplesRequired: 3
      additionalLatencyInMilliseconds: 50
    }
    healthProbeSettings: {
      probePath: '/health'
      probeRequestType: 'HEAD'
      probeProtocol: 'Https'
      probeIntervalInSeconds: 100
    }
    sessionAffinityState: 'Disabled'
  }
}

resource storefrontOrigin 'Microsoft.Cdn/profiles/originGroups/origins@2024-02-01' = {
  parent: storefrontOriginGroup
  name: 'storefront-origin'
  properties: {
    hostName: webApp.properties.configuration.ingress.fqdn
    originHostHeader: webApp.properties.configuration.ingress.fqdn
    httpPort: 80
    httpsPort: 443
    priority: 1
    weight: 1000
    enabledState: 'Enabled'
    enforceCertificateNameCheck: true
  }
}

resource storefrontRoute 'Microsoft.Cdn/profiles/afdEndpoints/routes@2024-02-01' = {
  parent: frontendEndpoint
  name: 'storefront-route'
  dependsOn: [storefrontOrigin]
  properties: {
    originGroup: { id: storefrontOriginGroup.id }
    supportedProtocols: ['Http', 'Https']
    patternsToMatch: ['/*']
    forwardingProtocol: 'HttpsOnly'
    linkToDefaultDomain: 'Enabled'
    httpsRedirect: 'Enabled'
    cacheConfiguration: {
      queryStringCachingBehavior: 'IgnoreQueryString'
      compressionSettings: {
        isCompressionEnabled: true
        contentTypesToCompress: [
          'text/html'
          'text/css'
          'text/javascript'
          'application/javascript'
          'application/json'
          'application/xml'
          'image/svg+xml'
          'font/woff2'
        ]
      }
    }
  }
}

resource wafPolicy 'Microsoft.Network/frontDoorWebApplicationFirewallPolicies@2022-05-01' = {
  name: wafName
  location: 'global'
  sku: { name: 'Premium_AzureFrontDoor' }
  properties: {
    policySettings: {
      enabledState: 'Enabled'
      mode: 'Prevention'
      requestBodyCheck: 'Enabled'
    }
    managedRules: {
      managedRuleSets: [
        {
          ruleSetType: 'Microsoft_DefaultRuleSet'
          ruleSetVersion: '2.1'
          ruleGroupOverrides: []
        }
        {
          ruleSetType: 'Microsoft_BotManagerRuleSet'
          ruleSetVersion: '1.1'
          ruleGroupOverrides: []
        }
      ]
    }
    customRules: {
      rules: []
    }
  }
}

resource wafAssociation 'Microsoft.Cdn/profiles/securityPolicies@2024-02-01' = {
  parent: frontendDoor
  name: 'storefront-waf'
  properties: {
    parameters: {
      type: 'WebApplicationFirewall'
      wafPolicy: { id: wafPolicy.id }
      associations: [
        {
          domains: [{ id: frontendEndpoint.id }]
          patternsToMatch: ['/*']
        }
      ]
    }
  }
}

resource apiApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: apiAppName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${apiIdentity.id}': {}
      '${imagePullIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: acaEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      registries: [{ server: registryServer, identity: imagePullIdentity.id }]
      secrets: [{ name: 'database-url', value: databaseUrl }]
      ingress: {
        external: false
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
        traffic: [{ latestRevision: true, weight: 100 }]
      }
    }
    template: {
      containers: [
        {
          name: 'shop-api'
          image: apiImage
          resources: { cpu: 1, memory: '2Gi' }
          env: [
            { name: 'SPRING_PROFILES_ACTIVE', value: 'production' }
            { name: 'APP_ENV', value: 'production' }
            { name: 'AZURE_KEYVAULT_URL', value: keyVault.properties.vaultUri }
            { name: 'AZURE_CLIENT_ID', value: apiIdentity.properties.clientId }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'DATABASE_USERNAME', value: databaseUsername }
            { name: 'REDIS_HOST', value: redisHost }
            { name: 'REDIS_SERVER_PORT', value: string(redisPort) }
            { name: 'REDIS_SSL_ENABLED', value: 'true' }
            { name: 'KAFKA_BOOTSTRAP_SERVERS', value: kafkaBootstrapServers }
            { name: 'KAFKA_SECURITY_PROTOCOL', value: kafkaSecurityProtocol }
            { name: 'KAFKA_SASL_MECHANISM', value: kafkaSaslMechanism }
            { name: 'MAIL_HOST', value: mailHost }
            { name: 'MAIL_PORT', value: string(mailPort) }
            { name: 'MAIL_USERNAME', value: mailUsername }
            { name: 'MAIL_AUTH', value: string(mailAuth) }
            { name: 'MAIL_STARTTLS', value: string(mailStartTls) }
            { name: 'MAIL_FROM', value: mailFrom }
            { name: 'PUBLIC_WEB_URL', value: 'https://${frontendEndpoint.properties.hostName}' }
            {
              name: 'ALLOWED_ORIGINS'
              value: empty(additionalAllowedOrigins)
                ? 'https://${frontendEndpoint.properties.hostName}'
                : 'https://${frontendEndpoint.properties.hostName},${additionalAllowedOrigins}'
            }
            { name: 'APP_NAME', value: 'shop-api' }
            { name: 'POD_NAME', value: 'shop-api-azure' }
            { name: 'MANAGEMENT_SERVER_PORT', value: '8081' }
            { name: 'MANAGEMENT_ENDPOINTS_WEB_EXPOSURE_INCLUDE', value: 'health,info,metrics,prometheus' }
            { name: 'WAITING_ROOM_REGISTRATION_CAPACITY', value: '100' }
            { name: 'WAITING_ROOM_CHECKOUT_CAPACITY', value: '100' }
            { name: 'WAITING_ROOM_MAXIMUM_QUEUED_TICKETS', value: '10000' }
            { name: 'WAITING_ROOM_ADMISSION_LEASE', value: 'PT5M' }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/actuator/health/liveness', port: 8081, scheme: 'HTTP' }
              initialDelaySeconds: 30
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: { path: '/actuator/health/readiness', port: 8081, scheme: 'HTTP' }
              initialDelaySeconds: 20
              periodSeconds: 15
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 3
        rules: [{ name: 'http-concurrency', http: { metadata: { concurrentRequests: '100' } } }]
      }
    }
  }
  dependsOn: [
    acrPullAssignment
    keyVaultSecretUser
    databasePasswordSecret
    jwtSecretValue
    redisPasswordSecret
    mailPasswordSecret
    apiClientsSecret
    kafkaJaasSecret
  ]
}

resource bffApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: bffAppName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${imagePullIdentity.id}': {} }
  }
  properties: {
    managedEnvironmentId: acaEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      registries: [{ server: registryServer, identity: imagePullIdentity.id }]
      ingress: {
        external: false
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
        traffic: [{ latestRevision: true, weight: 100 }]
      }
      secrets: [{ name: 'redis-url', value: bffRedisUrl }]
    }
    template: {
      containers: [
        {
          name: 'shop-bff'
          image: bffImage
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'API_URL', value: 'http://${apiApp.properties.configuration.ingress.fqdn}' }
            { name: 'REDIS_URL', secretRef: 'redis-url' }
            { name: 'PORT', value: '3000' }
            { name: 'METRICS_PORT', value: '3001' }
            { name: 'RATE_LIMIT_MAX', value: '100' }
            { name: 'RATE_LIMIT_WINDOW', value: '1 minute' }
            { name: 'APP_NAME', value: 'shop-bff' }
            { name: 'NODE_ENV', value: 'production' }
          ]
          probes: [
            {
              type: 'Readiness'
              httpGet: { path: '/health', port: 3000, scheme: 'HTTP' }
              initialDelaySeconds: 10
              periodSeconds: 15
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 3
        rules: [{ name: 'http-concurrency', http: { metadata: { concurrentRequests: '100' } } }]
      }
    }
  }
  dependsOn: [acrPullAssignment]
}

resource webApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: webAppName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${imagePullIdentity.id}': {} }
  }
  properties: {
    managedEnvironmentId: acaEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      registries: [{ server: registryServer, identity: imagePullIdentity.id }]
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
        traffic: [{ latestRevision: true, weight: 100 }]
      }
    }
    template: {
      containers: [
        {
          name: 'shop-storefront'
          image: webImage
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: [
            { name: 'BFF_HOST', value: bffApp.properties.configuration.ingress.fqdn }
            { name: 'BFF_PORT', value: '80' }
            { name: 'NGINX_RESOLVER', value: '168.63.129.16' }
          ]
          probes: [
            {
              type: 'Readiness'
              httpGet: { path: '/', port: 8080, scheme: 'HTTP' }
              initialDelaySeconds: 10
              periodSeconds: 15
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 5
        rules: [{ name: 'http-concurrency', http: { metadata: { concurrentRequests: '200' } } }]
      }
    }
  }
  dependsOn: [acrPullAssignment]
}

output storefrontUrl string = 'https://${frontendEndpoint.properties.hostName}'
output apiIngress string = apiApp.properties.configuration.ingress.fqdn
output keyVaultName string = keyVault.name
