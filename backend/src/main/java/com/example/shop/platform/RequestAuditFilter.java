package com.example.shop.platform;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.MDC;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.time.Instant;
import java.util.UUID;
import java.util.regex.Pattern;

@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class RequestAuditFilter extends OncePerRequestFilter {
    private static final Pattern SAFE_REQUEST_ID = Pattern.compile("[A-Za-z0-9._:-]{1,100}");
    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(RequestAuditFilter.class);
    private final String environment;
    private final String appName;
    private final String podName;

    public RequestAuditFilter(
            @Value("${app.environment}") String environment,
            @Value("${spring.application.name}") String appName,
            @Value("${app.pod-name}") String podName) {
        this.environment = environment;
        this.appName = appName;
        this.podName = podName;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String suppliedId = request.getHeader("X-Request-Id");
        String requestId = suppliedId != null && SAFE_REQUEST_ID.matcher(suppliedId).matches()
                ? suppliedId : UUID.randomUUID().toString();
        String timestamp = Instant.now().toString();
        String sessionId = safeLogValue(request.getHeader("X-Session-Id"));
        String remoteAddress = safeLogValue(request.getRemoteAddr());
        String forwardedAddress = safeLogValue(request.getHeader("X-Forwarded-For"));
        String forwardedPort = safeLogValue(request.getHeader("X-Forwarded-Port"));
        boolean hasAuthorization = request.getHeader("Authorization") != null;
        response.setHeader("X-Request-Id", requestId);
        MDC.put("requestId", requestId);
        try {
            chain.doFilter(request, response);
        } finally {
            log.info("audit requestId={} requestTimestamp={} sessionId={} remoteAddress={} forwardedAddress={} forwardedPort={} authorizationPresent={} environment={} domain={} appName={} podName={} level=INFO threadId={} method={} path={} status={}",
                    requestId, timestamp, sessionId, remoteAddress, forwardedAddress, forwardedPort,
                    hasAuthorization, environment, safeLogValue(request.getServerName()), appName, podName,
                    Thread.currentThread().threadId(), request.getMethod(), safeLogValue(request.getRequestURI()),
                    response.getStatus());
            MDC.remove("requestId");
        }
    }

    private static String safeLogValue(String value) {
        if (value == null) {
            return null;
        }
        String sanitized = value.replaceAll("[\\p{Cntrl}]", "_");
        return sanitized.substring(0, Math.min(sanitized.length(), 256));
    }
}
