package com.example.shop.auth;

import com.example.shop.platform.JwtService;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Locale;
import java.util.UUID;

import static org.springframework.http.HttpStatus.BAD_REQUEST;
import static org.springframework.http.HttpStatus.UNAUTHORIZED;

@Service
public class IdentityService {
    private static final Duration ACTION_LIFETIME = Duration.ofMinutes(30);
    private static final Duration REFRESH_LIFETIME = Duration.ofDays(30);
    private static final SecureRandom RANDOM = new SecureRandom();
    private final JdbcClient jdbc;
    private final PasswordEncoder passwordEncoder;
    private final JwtService jwtService;
    private final JavaMailSender mailSender;
    private final String mailFrom;
    private final String publicWebUrl;

    public IdentityService(
            JdbcClient jdbc,
            PasswordEncoder passwordEncoder,
            JwtService jwtService,
            JavaMailSender mailSender,
            @Value("${app.mail.from}") String mailFrom,
            @Value("${app.public-web-url}") String publicWebUrl) {
        this.jdbc = jdbc;
        this.passwordEncoder = passwordEncoder;
        this.jwtService = jwtService;
        this.mailSender = mailSender;
        this.mailFrom = mailFrom;
        this.publicWebUrl = publicWebUrl;
    }

    @Transactional
    public void register(String emailInput, String password) {
        String email = normalizeEmail(emailInput);
        validatePassword(password);
        UUID customerId = UUID.randomUUID();
        try {
            jdbc.sql("INSERT INTO customers (id, email, password_hash) VALUES (:id, :email, :hash)")
                    .param("id", customerId).param("email", email)
                    .param("hash", passwordEncoder.encode(password)).update();
        } catch (DuplicateKeyException ex) {
            return;
        }
        sendAction(customerId, email, "VERIFY_EMAIL", "Verify your Everyday account",
                "verify-email");
    }

    @Transactional
    public void verifyEmail(String token) {
        ActionToken action = consumeActionToken(token, "VERIFY_EMAIL");
        jdbc.sql("UPDATE customers SET email_verified = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = :id")
                .param("id", action.customerId()).update();
    }

    @Transactional
    public AuthSession login(String emailInput, String password) {
        String email = normalizeEmail(emailInput);
        Customer customer = jdbc.sql("""
                SELECT id, email, password_hash, email_verified
                FROM customers WHERE email = :email
                """).param("email", email)
                .query((rs, row) -> new Customer(
                        rs.getObject("id", UUID.class), rs.getString("email"),
                        rs.getString("password_hash"), rs.getBoolean("email_verified")))
                .optional()
                .orElseThrow(() -> invalidCredentials());
        if (!passwordEncoder.matches(password, customer.passwordHash())) {
            throw invalidCredentials();
        }
        if (!customer.emailVerified()) {
            throw invalidCredentials();
        }
        return createSession(customer.id());
    }

    @Transactional
    public AuthSession refresh(String refreshToken) {
        if (refreshToken == null || refreshToken.isBlank()) {
            throw invalidCredentials();
        }
        String oldHash = sha256(refreshToken);
        RefreshSession session = jdbc.sql("""
                SELECT id, customer_id, expires_at, revoked_at
                FROM refresh_sessions WHERE token_hash = :hash FOR UPDATE
                """).param("hash", oldHash)
                .query((rs, row) -> new RefreshSession(
                        rs.getLong("id"), rs.getObject("customer_id", UUID.class),
                        rs.getTimestamp("expires_at").toInstant(),
                        rs.getTimestamp("revoked_at") == null ? null : rs.getTimestamp("revoked_at").toInstant()))
                .optional()
                .orElseThrow(() -> invalidCredentials());
        if (session.revokedAt() != null || !session.expiresAt().isAfter(Instant.now())) {
            throw invalidCredentials();
        }
        AuthSession next = createSession(session.customerId());
        jdbc.sql("""
                UPDATE refresh_sessions
                SET revoked_at = CURRENT_TIMESTAMP, replaced_by_hash = :replacement
                WHERE id = :id AND revoked_at IS NULL
                """).param("replacement", sha256(next.refreshToken())).param("id", session.id()).update();
        return next;
    }

    @Transactional
    public void logout(String refreshToken) {
        if (refreshToken == null || refreshToken.isBlank()) {
            return;
        }
        jdbc.sql("""
                UPDATE refresh_sessions SET revoked_at = CURRENT_TIMESTAMP
                WHERE token_hash = :hash AND revoked_at IS NULL
                """).param("hash", sha256(refreshToken)).update();
    }

    @Transactional
    public void requestPasswordReset(String emailInput) {
        String email = normalizeEmail(emailInput);
        jdbc.sql("SELECT id FROM customers WHERE email = :email")
                .param("email", email)
                .query(UUID.class)
                .optional()
                .ifPresent(id -> sendAction(id, email, "RESET_PASSWORD",
                        "Reset your Everyday password", "reset-password"));
    }

    @Transactional
    public void resetPassword(String token, String newPassword) {
        validatePassword(newPassword);
        ActionToken action = consumeActionToken(token, "RESET_PASSWORD");
        jdbc.sql("""
                UPDATE customers SET password_hash = :hash, updated_at = CURRENT_TIMESTAMP
                WHERE id = :id
                """).param("hash", passwordEncoder.encode(newPassword))
                .param("id", action.customerId()).update();
        jdbc.sql("""
                UPDATE refresh_sessions SET revoked_at = CURRENT_TIMESTAMP
                WHERE customer_id = :id AND revoked_at IS NULL
                """).param("id", action.customerId()).update();
    }

    private AuthSession createSession(UUID customerId) {
        String refreshToken = randomToken();
        jdbc.sql("""
                INSERT INTO refresh_sessions (customer_id, token_hash, expires_at)
                VALUES (:id, :hash, :expires)
                """).param("id", customerId)
                .param("hash", sha256(refreshToken))
                .param("expires", Timestamp.from(Instant.now().plus(REFRESH_LIFETIME)))
                .update();
        TokenResponse access = jwtService.issue(customerId.toString(), "customer");
        return new AuthSession(access.accessToken(), access.tokenType(), access.expiresIn(), access.scope(),
                refreshToken, REFRESH_LIFETIME.toSeconds());
    }

    private void sendAction(UUID customerId, String email, String purpose, String subject, String path) {
        jdbc.sql("""
                UPDATE identity_action_tokens SET consumed_at = CURRENT_TIMESTAMP
                WHERE customer_id = :id AND purpose = :purpose AND consumed_at IS NULL
                """).param("id", customerId).param("purpose", purpose).update();
        String token = randomToken();
        jdbc.sql("""
                INSERT INTO identity_action_tokens (customer_id, token_hash, purpose, expires_at)
                VALUES (:id, :hash, :purpose, :expires)
                """).param("id", customerId)
                .param("hash", sha256(token))
                .param("purpose", purpose)
                .param("expires", Timestamp.from(Instant.now().plus(ACTION_LIFETIME)))
                .update();
        SimpleMailMessage message = new SimpleMailMessage();
        message.setFrom(mailFrom);
        message.setTo(email);
        message.setSubject(subject);
        message.setText("Use this one-time token at " + publicWebUrl + "/" + path
                + " . Token: " + token + "\nIt expires in 30 minutes.");
        mailSender.send(message);
    }

    private ActionToken consumeActionToken(String token, String purpose) {
        if (token == null || token.isBlank()) {
            throw new ResponseStatusException(BAD_REQUEST, "Invalid or expired action token");
        }
        ActionToken action = jdbc.sql("""
                SELECT id, customer_id, expires_at, consumed_at
                FROM identity_action_tokens
                WHERE token_hash = :hash AND purpose = :purpose
                FOR UPDATE
                """).param("hash", sha256(token)).param("purpose", purpose)
                .query((rs, row) -> new ActionToken(
                        rs.getLong("id"), rs.getObject("customer_id", UUID.class),
                        rs.getTimestamp("expires_at").toInstant(),
                        rs.getTimestamp("consumed_at") == null ? null : rs.getTimestamp("consumed_at").toInstant()))
                .optional()
                .orElseThrow(() -> new ResponseStatusException(BAD_REQUEST, "Invalid or expired action token"));
        if (action.consumedAt() != null || !action.expiresAt().isAfter(Instant.now())) {
            throw new ResponseStatusException(BAD_REQUEST, "Invalid or expired action token");
        }
        jdbc.sql("UPDATE identity_action_tokens SET consumed_at = CURRENT_TIMESTAMP WHERE id = :id")
                .param("id", action.id()).update();
        return action;
    }

    private static String normalizeEmail(String email) {
        return email.trim().toLowerCase(Locale.ROOT);
    }

    private static void validatePassword(String password) {
        if (password == null || password.length() < 12
                || password.getBytes(StandardCharsets.UTF_8).length > 72) {
            throw new ResponseStatusException(BAD_REQUEST,
                    "Password must be at least 12 characters and at most 72 UTF-8 bytes");
        }
    }

    private static ResponseStatusException invalidCredentials() {
        return new ResponseStatusException(UNAUTHORIZED, "Invalid email or password");
    }

    private static String randomToken() {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private static String sha256(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException("SHA-256 is unavailable", ex);
        }
    }

    public record AuthSession(String accessToken, String tokenType, long expiresIn, String scope,
                              String refreshToken, long refreshExpiresIn) {}
    private record Customer(UUID id, String email, String passwordHash, boolean emailVerified) {}
    private record RefreshSession(long id, UUID customerId, Instant expiresAt, Instant revokedAt) {}
    private record ActionToken(long id, UUID customerId, Instant expiresAt, Instant consumedAt) {}
}
