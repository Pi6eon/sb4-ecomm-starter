package com.example.shop.platform;

import com.azure.identity.DefaultAzureCredentialBuilder;
import com.azure.security.keyvault.secrets.SecretClient;
import com.azure.security.keyvault.secrets.SecretClientBuilder;
import org.springframework.boot.EnvironmentPostProcessor;
import org.springframework.boot.SpringApplication;
import org.springframework.core.Ordered;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;

import java.util.LinkedHashMap;
import java.util.Map;

public class KeyVaultEnvironmentPostProcessor implements EnvironmentPostProcessor, Ordered {
    private static final Map<String, String> SECRET_NAMES = Map.of(
            "DATABASE_PASSWORD", "database-password",
            "JWT_SECRET", "jwt-secret",
            "REDIS_PASSWORD", "redis-password",
            "MAIL_PASSWORD", "mail-password",
            "API_CLIENTS_JSON", "api-clients-json",
            "KAFKA_SASL_JAAS_CONFIG", "kafka-sasl-jaas-config");

    @Override
    public void postProcessEnvironment(ConfigurableEnvironment environment, SpringApplication application) {
        String vaultUrl = environment.getProperty("AZURE_KEYVAULT_URL");
        String profile = environment.getProperty("APP_ENV", "local");
        if (vaultUrl == null || vaultUrl.isBlank()) {
            if (!"local".equalsIgnoreCase(profile)) {
                throw new IllegalStateException("AZURE_KEYVAULT_URL is required outside the local profile");
            }
            return;
        }

        SecretClient client = new SecretClientBuilder()
                .vaultUrl(vaultUrl)
                .credential(new DefaultAzureCredentialBuilder().build())
                .buildClient();
        Map<String, Object> secrets = new LinkedHashMap<>();
        for (var entry : SECRET_NAMES.entrySet()) {
            String value = client.getSecret(entry.getValue()).getValue();
            if (value == null || value.isBlank()) {
                throw new IllegalStateException("Required Key Vault secret is empty: " + entry.getValue());
            }
            secrets.put(entry.getKey(), value);
        }
        try {
            String previousJwtSecret = client.getSecret("jwt-previous-secret").getValue();
            if (previousJwtSecret != null && !previousJwtSecret.isBlank()) {
                secrets.put("JWT_PREVIOUS_SECRET", previousJwtSecret);
            }
        } catch (com.azure.core.exception.ResourceNotFoundException ignored) {
        }
        try {
            String previousClients = client.getSecret("api-clients-json-previous").getValue();
            if (previousClients != null && !previousClients.isBlank()) {
                secrets.put("API_CLIENTS_JSON_PREVIOUS", previousClients);
            }
        } catch (com.azure.core.exception.ResourceNotFoundException ignored) {
        }
        environment.getPropertySources().addFirst(new MapPropertySource("azure-key-vault", secrets));
    }

    @Override
    public int getOrder() {
        return Ordered.LOWEST_PRECEDENCE;
    }
}
