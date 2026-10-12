package com.example.shop.platform;

import io.jsonwebtoken.JwtException;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.Base64;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class JwtServiceTest {
    private static final String SECRET =
            Base64.getEncoder().encodeToString("local-test-signing-secret-at-least-32-bytes".getBytes());

    @Test
    void issuesSignedGuestTokensWithExpectedClaims() {
        var service = new JwtService(SECRET, "", Duration.ofHours(2), "shop-test");

        var token = service.issue("shopper@example.com", "guest");
        var claims = service.parse(token.accessToken());

        assertEquals("shopper@example.com", claims.getSubject());
        assertEquals("guest", claims.get("token_type", String.class));
        assertEquals("shop-test", claims.getIssuer());
        assertEquals("shop-api", claims.getAudience().iterator().next());
        assertEquals("Bearer", token.tokenType());
        assertEquals(7200, token.expiresIn());
    }

    @Test
    void rejectsTokensSignedByAnotherKey() {
        var issuer = new JwtService(SECRET, "", Duration.ofHours(2), "shop-test");
        var verifier = new JwtService(
                Base64.getEncoder().encodeToString("different-test-signing-key-at-least-32-bytes".getBytes()),
                "", Duration.ofHours(2), "shop-test");
        var token = issuer.issue("shopper@example.com", "guest");

        assertThrows(JwtException.class, () -> verifier.parse(token.accessToken()));
    }

    @Test
    void acceptsPreviousSigningKeyDuringRotationOverlap() {
        var previousKey = Base64.getEncoder()
                .encodeToString("different-test-signing-key-at-least-32-bytes".getBytes());
        var oldIssuer = new JwtService(previousKey, "", Duration.ofHours(2), "shop-test");
        var rotatedVerifier = new JwtService(SECRET, previousKey, Duration.ofHours(2), "shop-test");
        var oldToken = oldIssuer.issue("shopper@example.com", "guest");

        assertEquals("shopper@example.com", rotatedVerifier.parse(oldToken.accessToken()).getSubject());
    }
}
