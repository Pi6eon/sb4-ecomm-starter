package com.example.shop.platform;

import com.example.shop.auth.TokenResponse;
import io.jsonwebtoken.Claims;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.SignatureException;
import io.jsonwebtoken.io.Decoders;
import io.jsonwebtoken.security.Keys;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import javax.crypto.SecretKey;
import java.time.Duration;
import java.time.Instant;
import java.util.Date;
import java.util.UUID;

@Service
public class JwtService {
    private final SecretKey key;
    private final SecretKey previousKey;
    private final Duration lifetime;
    private final String issuer;

    public JwtService(
            @Value("${app.jwt.secret}") String secret,
            @Value("${app.jwt.previous-secret:}") String previousSecret,
            @Value("${app.jwt.lifetime}") Duration lifetime,
            @Value("${app.jwt.issuer}") String issuer) {
        this.key = Keys.hmacShaKeyFor(Decoders.BASE64.decode(secret));
        this.previousKey = previousSecret.isBlank()
                ? null : Keys.hmacShaKeyFor(Decoders.BASE64.decode(previousSecret));
        this.lifetime = lifetime;
        this.issuer = issuer;
    }

    public TokenResponse issue(String subject, String tokenType) {
        return issue(subject, tokenType, java.util.List.of());
    }

    public TokenResponse issue(String subject, String tokenType, java.util.List<String> scopes) {
        Instant now = Instant.now();
        var builder = Jwts.builder()
                .id(UUID.randomUUID().toString())
                .subject(subject)
                .issuer(issuer)
                .audience().add("shop-api").and()
                .claim("token_type", tokenType)
                .issuedAt(Date.from(now))
                .expiration(Date.from(now.plus(lifetime)));
        if (!scopes.isEmpty()) {
            builder.claim("scope", scopes);
        }
        String token = builder.signWith(key).compact();
        return new TokenResponse(token, "Bearer", lifetime.toSeconds(), tokenType);
    }

    public Claims parse(String token) {
        try {
            return parser(key).parseSignedClaims(token).getPayload();
        } catch (SignatureException ex) {
            if (previousKey == null) {
                throw ex;
            }
            return parser(previousKey).parseSignedClaims(token).getPayload();
        }
    }

    private io.jsonwebtoken.JwtParser parser(SecretKey signingKey) {
        return Jwts.parser().verifyWith(signingKey).requireIssuer(issuer).requireAudience("shop-api").build();
    }
}
