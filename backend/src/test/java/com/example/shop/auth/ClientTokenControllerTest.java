package com.example.shop.auth;

import com.example.shop.platform.JwtService;
import org.junit.jupiter.api.Test;
import org.springframework.web.server.ResponseStatusException;

import java.time.Duration;
import java.util.Base64;
import tools.jackson.databind.ObjectMapper;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class ClientTokenControllerTest {
    private static final String SECRET =
            Base64.getEncoder().encodeToString("test-client-signing-key-at-least-32-bytes".getBytes());
    private static final String CLIENTS = """
            [{"clientId":"mobile","clientSecret":"mobile-secret","scopes":["catalog:read","orders:write"]},
             {"clientId":"partner","clientSecret":"partner-secret","scopes":["catalog:read"]}]
            """;

    private final JwtService jwtService = new JwtService(SECRET, "", Duration.ofMinutes(15), "shop-test");
    private final ClientTokenController controller = new ClientTokenController(
            jwtService, new ObjectMapper(), CLIENTS, "[]");

    @Test
    void issuesOnlyTheConfiguredClientScopes() {
        var response = controller.token(basic("partner", "partner-secret"),
                "client_credentials", "catalog:read");
        var claims = jwtService.parse(response.accessToken());

        assertEquals("partner", claims.getSubject());
        assertEquals("client", claims.get("token_type", String.class));
        assertEquals("catalog:read", claims.get("scope", java.util.List.class).getFirst());
    }

    @Test
    void rejectsUnconfiguredScopeAndInvalidCredentials() {
        assertThrows(ResponseStatusException.class, () -> controller.token(
                basic("partner", "partner-secret"), "client_credentials", "orders:write"));
        assertThrows(ResponseStatusException.class, () -> controller.token(
                basic("partner", "wrong-secret"), "client_credentials", "catalog:read"));
    }

    private static String basic(String clientId, String secret) {
        String encoded = Base64.getEncoder().encodeToString((clientId + ":" + secret).getBytes());
        return "Basic " + encoded;
    }
}
