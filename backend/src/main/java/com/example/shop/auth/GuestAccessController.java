package com.example.shop.auth;

import com.example.shop.platform.JwtService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
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

import static org.springframework.http.HttpStatus.BAD_REQUEST;

@RestController
@RequestMapping("/api/v1/guest-access")
public class GuestAccessController {
    private static final Duration TOKEN_LIFETIME = Duration.ofMinutes(10);
    private static final SecureRandom RANDOM = new SecureRandom();
    private final JdbcClient jdbc;
    private final JavaMailSender mailSender;
    private final JwtService jwtService;
    private final String mailFrom;
    private final String publicWebUrl;

    public GuestAccessController(
            JdbcClient jdbc,
            JavaMailSender mailSender,
            JwtService jwtService,
            @Value("${app.mail.from}") String mailFrom,
            @Value("${app.public-web-url}") String publicWebUrl) {
        this.jdbc = jdbc;
        this.mailSender = mailSender;
        this.jwtService = jwtService;
        this.mailFrom = mailFrom;
        this.publicWebUrl = publicWebUrl;
    }

    @PostMapping("/request")
    @org.springframework.web.bind.annotation.ResponseStatus(HttpStatus.ACCEPTED)
    @Transactional
    Message request(@Valid @RequestBody EmailRequest request) {
        String email = normalizeEmail(request.email());
        boolean hasOrders = jdbc.sql("SELECT EXISTS (SELECT 1 FROM orders WHERE customer_subject = :email)")
                .param("email", email)
                .query(Boolean.class)
                .single();
        if (hasOrders) {
            jdbc.sql("""
                    UPDATE guest_access_tokens SET consumed_at = CURRENT_TIMESTAMP
                    WHERE email = :email AND purpose = 'history' AND consumed_at IS NULL
                    """).param("email", email).update();
            String token = randomToken();
            jdbc.sql("""
                    INSERT INTO guest_access_tokens (email, token_hash, expires_at, purpose)
                    VALUES (:email, :hash, :expires, 'history')
                    """).param("email", email)
                    .param("hash", sha256(token))
                    .param("expires", Timestamp.from(Instant.now().plus(TOKEN_LIFETIME)))
                    .update();
            SimpleMailMessage message = new SimpleMailMessage();
            message.setFrom(mailFrom);
            message.setTo(email);
            message.setSubject("Your Everyday guest order access code");
            message.setText("Use this one-time code to access your guest profile and order history at "
                    + publicWebUrl + ". Code: " + token + "\nIt expires in 10 minutes.");
            mailSender.send(message);
        }
        return new Message("If guest orders exist for this email, an access code will be sent.");
    }

    @PostMapping("/verify")
    @Transactional
    TokenResponse verify(@Valid @RequestBody VerificationRequest request) {
        String email = normalizeEmail(request.email());
        String tokenHash = sha256(request.token());
        GuestAccessToken accessToken = jdbc.sql("""
                SELECT id, expires_at, consumed_at
                FROM guest_access_tokens
                WHERE email = :email AND token_hash = :hash AND purpose = 'history'
                FOR UPDATE
                """).param("email", email).param("hash", tokenHash)
                .query((rs, row) -> new GuestAccessToken(
                        rs.getLong("id"),
                        rs.getTimestamp("expires_at").toInstant(),
                        rs.getTimestamp("consumed_at") == null
                                ? null : rs.getTimestamp("consumed_at").toInstant()))
                .optional()
                .orElseThrow(GuestAccessController::invalidToken);
        if (accessToken.consumedAt() != null || !accessToken.expiresAt().isAfter(Instant.now())) {
            throw invalidToken();
        }
        jdbc.sql("UPDATE guest_access_tokens SET consumed_at = CURRENT_TIMESTAMP WHERE id = :id")
                .param("id", accessToken.id()).update();
        boolean hasOrders = jdbc.sql("SELECT EXISTS (SELECT 1 FROM orders WHERE customer_subject = :email)")
                .param("email", email)
                .query(Boolean.class)
                .single();
        if (!hasOrders) {
            throw invalidToken();
        }
        return jwtService.issue(email, "guest_verified");
    }

    @PostMapping("/checkout/request")
    @org.springframework.web.bind.annotation.ResponseStatus(HttpStatus.ACCEPTED)
    @Transactional
    Message requestCheckoutCode(@Valid @RequestBody EmailRequest request) {
        String email = normalizeEmail(request.email());
        jdbc.sql("""
                UPDATE guest_access_tokens SET consumed_at = CURRENT_TIMESTAMP
                WHERE email = :email AND purpose = 'checkout' AND consumed_at IS NULL
                """).param("email", email).update();
        String token = randomToken();
        jdbc.sql("""
                INSERT INTO guest_access_tokens (email, token_hash, expires_at, purpose)
                VALUES (:email, :hash, :expires, 'checkout')
                """).param("email", email)
                .param("hash", sha256(token))
                .param("expires", Timestamp.from(Instant.now().plus(TOKEN_LIFETIME)))
                .update();
        SimpleMailMessage message = new SimpleMailMessage();
        message.setFrom(mailFrom);
        message.setTo(email);
        message.setSubject("Your Everyday guest checkout verification code");
        message.setText("Use this one-time code to verify your email for guest checkout at "
                + publicWebUrl + ". Code: " + token + "\nIt expires in 10 minutes.");
        mailSender.send(message);
        return new Message("If the email is valid, a verification code will be sent.");
    }

    @PostMapping("/checkout/verify")
    @Transactional
    TokenResponse verifyCheckoutCode(@Valid @RequestBody VerificationRequest request) {
        String email = normalizeEmail(request.email());
        String tokenHash = sha256(request.token());
        GuestAccessToken accessToken = jdbc.sql("""
                SELECT id, expires_at, consumed_at
                FROM guest_access_tokens
                WHERE email = :email AND token_hash = :hash AND purpose = 'checkout'
                FOR UPDATE
                """).param("email", email).param("hash", tokenHash)
                .query((rs, row) -> new GuestAccessToken(
                        rs.getLong("id"),
                        rs.getTimestamp("expires_at").toInstant(),
                        rs.getTimestamp("consumed_at") == null
                                ? null : rs.getTimestamp("consumed_at").toInstant()))
                .optional()
                .orElseThrow(GuestAccessController::invalidToken);
        if (accessToken.consumedAt() != null || !accessToken.expiresAt().isAfter(Instant.now())) {
            throw invalidToken();
        }
        jdbc.sql("UPDATE guest_access_tokens SET consumed_at = CURRENT_TIMESTAMP WHERE id = :id")
                .param("id", accessToken.id()).update();
        return jwtService.issue(email, "guest");
    }

    private static String normalizeEmail(String email) {
        return email.trim().toLowerCase(Locale.ROOT);
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

    private static ResponseStatusException invalidToken() {
        return new ResponseStatusException(BAD_REQUEST, "Invalid or expired guest access code");
    }

    public record EmailRequest(@NotBlank @Email @Size(max = 254) String email) {}
    public record VerificationRequest(
            @NotBlank @Email @Size(max = 254) String email,
            @NotBlank String token) {}
    public record Message(String message) {}
    private record GuestAccessToken(long id, Instant expiresAt, Instant consumedAt) {}
}
