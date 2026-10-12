package com.example.shop.platform;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.HexFormat;
import java.util.List;

@Component
public class RedisRateLimitFilter extends OncePerRequestFilter {
    private static final DefaultRedisScript<Long> INCREMENT = new DefaultRedisScript<>("""
            local count = redis.call('INCR', KEYS[1])
            if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
            return count
            """, Long.class);
    private static final Duration WINDOW = Duration.ofMinutes(1);
    private final StringRedisTemplate redis;

    public RedisRateLimitFilter(StringRedisTemplate redis) {
        this.redis = redis;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return request.getRequestURI().startsWith("/actuator/health")
                || request.getRequestURI().equals("/actuator/prometheus")
                || request.getMethod().equals("OPTIONS");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        String identity = authentication != null && authentication.isAuthenticated()
                && !"anonymousUser".equals(authentication.getPrincipal())
                ? authentication.getName() + ":" + request.getRemoteAddr()
                : request.getRemoteAddr();
        int limit = routeLimit(request.getRequestURI());
        try {
            String key = "shop:rate:v1:" + routeGroup(request.getRequestURI()) + ":" + digest(identity);
            Long count = redis.execute(INCREMENT, List.of(key), Long.toString(WINDOW.toMillis()));
            if (count == null) {
                throw new IllegalStateException("Redis returned no rate-limit counter");
            }
            response.setHeader("X-RateLimit-Limit", Integer.toString(limit));
            response.setHeader("X-RateLimit-Remaining", Integer.toString(Math.max(0, limit - count.intValue())));
            if (count > limit) {
                response.setHeader("Retry-After", Long.toString(WINDOW.toSeconds()));
                response.sendError(429, "Rate limit exceeded");
                return;
            }
        } catch (org.springframework.dao.DataAccessException ex) {
            response.sendError(HttpStatus.SERVICE_UNAVAILABLE.value(), "Rate limit service unavailable");
            return;
        }
        chain.doFilter(request, response);
    }

    private static int routeLimit(String path) {
        if (path.startsWith("/api/v1/oauth/")) return 10;
        if (path.equals("/api/v1/guest-access/request")) return 5;
        if (path.equals("/api/v1/guest-access/checkout/request")) return 5;
        if (path.startsWith("/api/v1/guest-access/")) return 10;
        if (path.startsWith("/api/v1/waiting-room/")) return 60;
        if (path.startsWith("/api/v1/auth/")) return 60;
        if (path.equals("/api/v1/orders") || path.startsWith("/api/v1/orders/")) return 30;
        return 120;
    }

    private static String routeGroup(String path) {
        if (path.startsWith("/api/v1/auth/") || path.startsWith("/api/v1/oauth/")
                || path.startsWith("/api/v1/guest-access/")) return "auth";
        if (path.startsWith("/api/v1/orders")) return "orders";
        return "api";
    }

    private static String digest(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException("SHA-256 is unavailable", ex);
        }
    }
}
