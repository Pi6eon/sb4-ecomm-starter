package com.example.shop.platform;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/waiting-room")
public class WaitingRoomController {
    private final WaitingRoomService waitingRoom;

    public WaitingRoomController(WaitingRoomService waitingRoom) {
        this.waitingRoom = waitingRoom;
    }

    @PostMapping("/{flow}/tickets")
    WaitingRoomService.Ticket join(@PathVariable String flow, @Valid @RequestBody JoinRequest request) {
        WaitingRoomService.Ticket ticket = waitingRoom.join(parseFlow(flow), request.ticketId());
        if ("full".equals(ticket.state())) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Waiting room is full; try again later");
        }
        return ticket;
    }

    @GetMapping("/{flow}/tickets/{ticketId}")
    WaitingRoomService.Ticket status(@PathVariable String flow, @PathVariable UUID ticketId) {
        return waitingRoom.status(parseFlow(flow), ticketId);
    }

    private static WaitingRoomService.Flow parseFlow(String value) {
        try {
            return WaitingRoomService.Flow.fromPath(value);
        } catch (IllegalArgumentException exception) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unsupported waiting-room flow");
        }
    }

    public record JoinRequest(@NotNull UUID ticketId) {}
}
