package com.example.shop.auth;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import jakarta.servlet.http.HttpServletRequest;
import com.example.shop.platform.WaitingRoomGateFilter;
import com.example.shop.platform.WaitingRoomService;

@RestController
@RequestMapping("/api/v1/auth")
public class CustomerIdentityController {
    private final IdentityService identity;
    private final WaitingRoomService waitingRoom;

    public CustomerIdentityController(IdentityService identity, WaitingRoomService waitingRoom) {
        this.identity = identity;
        this.waitingRoom = waitingRoom;
    }

    @PostMapping("/register")
    @org.springframework.web.bind.annotation.ResponseStatus(HttpStatus.ACCEPTED)
    Message register(@Valid @RequestBody Credentials request, HttpServletRequest servletRequest) {
        String ticketId = (String) servletRequest.getAttribute(WaitingRoomGateFilter.TICKET_ATTRIBUTE);
        try {
            identity.register(request.email(), request.password());
        } finally {
            waitingRoom.complete(WaitingRoomService.Flow.REGISTRATION, ticketId);
        }
        return new Message("If the email can be registered, a verification message will be sent.");
    }

    @PostMapping("/verify-email")
    Message verifyEmail(@Valid @RequestBody ActionTokenRequest request) {
        identity.verifyEmail(request.token());
        return new Message("Email verified. You can now sign in.");
    }

    @PostMapping("/login")
    IdentityService.AuthSession login(@Valid @RequestBody Credentials request) {
        return identity.login(request.email(), request.password());
    }

    @PostMapping("/refresh")
    IdentityService.AuthSession refresh(@Valid @RequestBody RefreshRequest request) {
        return identity.refresh(request.refreshToken());
    }

    @PostMapping("/logout")
    Message logout(@Valid @RequestBody RefreshRequest request) {
        identity.logout(request.refreshToken());
        return new Message("Session revoked.");
    }

    @PostMapping("/password/forgot")
    @org.springframework.web.bind.annotation.ResponseStatus(HttpStatus.ACCEPTED)
    Message forgotPassword(@Valid @RequestBody EmailRequest request) {
        identity.requestPasswordReset(request.email());
        return new Message("If an account exists, password reset instructions will be sent.");
    }

    @PostMapping("/password/reset")
    Message resetPassword(@Valid @RequestBody PasswordResetRequest request) {
        identity.resetPassword(request.token(), request.newPassword());
        return new Message("Password updated. Sign in again with the new password.");
    }

    public record Credentials(@NotBlank @Email @Size(max = 254) String email,
                              @NotBlank @Size(max = 256) String password) {}
    public record EmailRequest(@NotBlank @Email @Size(max = 254) String email) {}
    public record ActionTokenRequest(@NotBlank String token) {}
    public record RefreshRequest(@NotBlank String refreshToken) {}
    public record PasswordResetRequest(@NotBlank String token, @NotBlank @Size(max = 256) String newPassword) {}
    public record Message(String message) {}
}
