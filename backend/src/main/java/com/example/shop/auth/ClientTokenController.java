package com.example.shop.auth;

import com.example.shop.platform.JwtService;
import tools.jackson.core.JacksonException;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;
import jakarta.validation.constraints.NotBlank;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Base64;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/oauth")
public class ClientTokenController {
    private final JwtService jwtService;
    private final Map<String, ClientRegistration> clients;
    private final Map<String, String> previousSecrets;

    public ClientTokenController(
            JwtService jwtService,
            ObjectMapper objectMapper,
            @Value("${app.api-clients.json:[]}") String currentClients,
            @Value("${app.api-clients.previous-json:[]}") String previousClients) {
        this.jwtService = jwtService;
        this.clients = parseClients(objectMapper, currentClients);
        Map<String, String> oldSecrets = new HashMap<>();
        parseClients(objectMapper, previousClients)
                .forEach((id, client) -> oldSecrets.put(id, client.clientSecret()));
        this.previousSecrets = Map.copyOf(oldSecrets);
    }

    @PostMapping("/token")
    TokenResponse token(
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization,
            @RequestParam(defaultValue = "client_credentials") String grantType,
            @RequestParam(defaultValue = "catalog:read") @NotBlank String scope) {
        if (!"client_credentials".equals(grantType)
                || clients.isEmpty()) {
            throw invalidClient();
        }
        String[] credentials = decodeBasic(authorization);
        ClientRegistration client = clients.get(credentials[0]);
        if (client == null) {
            throw invalidClient();
        }
        boolean currentSecret = constantEquals(client.clientSecret(), credentials[1]);
        String previousSecret = previousSecrets.get(credentials[0]);
        boolean previousSecretMatches = previousSecret != null && constantEquals(previousSecret, credentials[1]);
        if (!(currentSecret | previousSecretMatches)) throw invalidClient();
        List<String> requestedScopes = Arrays.stream(scope.trim().split("\\s+")).distinct().toList();
        if (requestedScopes.isEmpty() || !client.scopes().containsAll(requestedScopes)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Requested scope is not allowed");
        }
        return jwtService.issue(client.clientId(), "client", requestedScopes);
    }

    private static Map<String, ClientRegistration> parseClients(ObjectMapper mapper, String json) {
        try {
            List<ClientRegistration> registrations = mapper.readValue(
                    json, new TypeReference<>() {});
            Map<String, ClientRegistration> result = new HashMap<>();
            for (ClientRegistration client : registrations) {
                if (!StringUtils.hasText(client.clientId()) || !StringUtils.hasText(client.clientSecret())
                        || client.scopes() == null || client.scopes().isEmpty()
                        || result.putIfAbsent(client.clientId(), client) != null) {
                    throw new IllegalStateException("API client configuration has empty or duplicate entries");
                }
            }
            return result;
        } catch (JacksonException ex) {
            throw new IllegalStateException("API client configuration is not valid JSON", ex);
        }
    }

    private static String[] decodeBasic(String authorization) {
        if (!authorization.startsWith("Basic ")) {
            throw invalidClient();
        }
        try {
            String decoded = new String(Base64.getDecoder().decode(authorization.substring(6)), StandardCharsets.UTF_8);
            int separator = decoded.indexOf(':');
            if (separator <= 0 || separator == decoded.length() - 1) {
                throw invalidClient();
            }
            return new String[]{decoded.substring(0, separator), decoded.substring(separator + 1)};
        } catch (IllegalArgumentException ex) {
            throw invalidClient();
        }
    }

    private static boolean constantEquals(String expected, String actual) {
        return MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8),
                actual.getBytes(StandardCharsets.UTF_8));
    }

    private static ResponseStatusException invalidClient() {
        return new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Invalid client credentials");
    }

    public record ClientRegistration(String clientId, String clientSecret, List<String> scopes) {}
}
