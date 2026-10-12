package com.example.shop.orders;

import jakarta.validation.Valid;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import static org.springframework.http.HttpStatus.FORBIDDEN;

import java.util.List;
import java.util.UUID;
import java.util.regex.Pattern;
import jakarta.servlet.http.HttpServletRequest;
import com.example.shop.platform.WaitingRoomGateFilter;
import com.example.shop.platform.WaitingRoomService;

@RestController
@RequestMapping("/api/v1/orders")
public class OrderController {
    private static final Pattern IDEMPOTENCY_KEY = Pattern.compile("[A-Za-z0-9._:-]{16,128}");
    private final OrderService orders;
    private final WaitingRoomService waitingRoom;

    public OrderController(OrderService orders, WaitingRoomService waitingRoom) {
        this.orders = orders;
        this.waitingRoom = waitingRoom;
    }

    @PostMapping
    OrderResponse create(
            @RequestHeader("Idempotency-Key") String idempotencyKey,
            @Valid @RequestBody OrderRequest request, Authentication authentication,
            HttpServletRequest servletRequest) {
        if (!IDEMPOTENCY_KEY.matcher(idempotencyKey).matches()) {
            throw new org.springframework.web.server.ResponseStatusException(
                    org.springframework.http.HttpStatus.BAD_REQUEST, "A 16-128 character Idempotency-Key is required");
        }
        boolean eligible = authentication.getAuthorities().stream()
                .map(GrantedAuthority::getAuthority)
                .anyMatch(authority -> authority.equals("TOKEN_GUEST") || authority.equals("TOKEN_CUSTOMER")
                        || authority.equals("SCOPE_orders:write"));
        if (!eligible) {
            throw new ResponseStatusException(FORBIDDEN, "Guest or customer token required");
        }
        String ticketId = (String) servletRequest.getAttribute(WaitingRoomGateFilter.TICKET_ATTRIBUTE);
        try {
            return orders.create(authentication.getName(), idempotencyKey, request);
        } finally {
            if (ticketId != null) {
                waitingRoom.complete(WaitingRoomService.Flow.CHECKOUT, ticketId);
            }
        }
    }

    @GetMapping
    List<OrderResponse> list(
            Authentication authentication,
            @RequestParam(defaultValue = "20") int limit,
            @RequestParam(defaultValue = "0") int offset) {
        requireOrderHistoryAccess(authentication);
        validatePagination(limit, offset);
        return orders.findOrders(authentication.getName(), limit, offset);
    }

    @GetMapping("/history")
    List<OrderHistoryResponse> history(
            Authentication authentication,
            @RequestParam(defaultValue = "20") int limit,
            @RequestParam(defaultValue = "0") int offset) {
        requireOrderHistoryAccess(authentication);
        validatePagination(limit, offset);
        return orders.findOrderHistory(authentication.getName(), limit, offset);
    }

    private static void validatePagination(int limit, int offset) {
        if (limit < 1 || limit > 100 || offset < 0 || offset > 10_000) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST,
                    "limit must be 1-100 and offset must be 0-10000");
        }
    }

    @GetMapping("/{id}")
    OrderResponse get(@PathVariable UUID id, Authentication authentication) {
        requireOrderHistoryAccess(authentication);
        return orders.findOrder(authentication.getName(), id);
    }

    private static void requireOrderHistoryAccess(Authentication authentication) {
        boolean eligible = authentication != null && authentication.getAuthorities().stream()
                .map(GrantedAuthority::getAuthority)
                .anyMatch(authority -> authority.equals("TOKEN_GUEST_VERIFIED")
                        || authority.equals("TOKEN_CUSTOMER") || authority.equals("SCOPE_orders:read"));
        if (!eligible) {
            throw new ResponseStatusException(FORBIDDEN, "Verified guest or customer token required");
        }
    }
}
