package com.example.shop.platform;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import java.io.IOException;

@Component
public class WaitingRoomGateFilter extends OncePerRequestFilter {
    public static final String TICKET_ATTRIBUTE = WaitingRoomGateFilter.class.getName() + ".ticket";
    private static final String TICKET_HEADER = "X-Waiting-Room-Ticket";
    private final WaitingRoomService waitingRoom;

    public WaitingRoomGateFilter(WaitingRoomService waitingRoom) {
        this.waitingRoom = waitingRoom;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String path = request.getRequestURI();
        return !(request.getMethod().equals("POST") && path.equals("/api/v1/auth/register"))
                && !(request.getMethod().equals("POST") && path.equals("/api/v1/orders"));
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String path = request.getRequestURI();
        WaitingRoomService.Flow flow;
        if (path.equals("/api/v1/auth/register")) {
            flow = WaitingRoomService.Flow.REGISTRATION;
        } else {
            Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
            boolean guest = authentication != null && authentication.getAuthorities().stream()
                    .map(GrantedAuthority::getAuthority)
                    .anyMatch("TOKEN_GUEST"::equals);
            if (!guest) {
                chain.doFilter(request, response);
                return;
            }
            flow = WaitingRoomService.Flow.CHECKOUT;
        }
        String ticketId = request.getHeader(TICKET_HEADER);
        if (ticketId == null || !ticketId.matches("[0-9a-fA-F-]{36}")
                || !waitingRoom.isAdmitted(flow, ticketId)) {
            response.sendError(HttpServletResponse.SC_FORBIDDEN, "An active waiting-room ticket is required");
            return;
        }
        request.setAttribute(TICKET_ATTRIBUTE, ticketId);
        chain.doFilter(request, response);
    }
}
