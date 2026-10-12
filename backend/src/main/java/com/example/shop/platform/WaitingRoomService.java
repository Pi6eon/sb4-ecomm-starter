package com.example.shop.platform;

import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.stereotype.Service;
import java.time.Duration;
import java.util.List;
import java.util.UUID;

@Service
public class WaitingRoomService {
    private static final long QUEUE_RETENTION = Duration.ofHours(24).toMillis();
    private static final DefaultRedisScript<String> QUEUE_AND_PROMOTE = new DefaultRedisScript<>("""
            local now = tonumber(ARGV[1])
            local capacity = tonumber(ARGV[2])
            local lease = tonumber(ARGV[3])
            local retention = tonumber(ARGV[4])
            local maxQueued = tonumber(ARGV[6])
            redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
            while redis.call('ZCARD', KEYS[2]) < capacity do
              local next = redis.call('ZRANGE', KEYS[1], 0, 0)
              if #next == 0 then break end
              redis.call('ZREM', KEYS[1], next[1])
              redis.call('ZADD', KEYS[2], now + lease, next[1])
            end
            if not redis.call('ZSCORE', KEYS[2], ARGV[5])
                and not redis.call('ZSCORE', KEYS[1], ARGV[5]) then
              if redis.call('ZCARD', KEYS[1]) >= maxQueued then return 'full|0' end
              local sequence = redis.call('INCR', KEYS[3])
              redis.call('ZADD', KEYS[1], 'NX', sequence, ARGV[5])
            end
            while redis.call('ZCARD', KEYS[2]) < capacity do
              local next = redis.call('ZRANGE', KEYS[1], 0, 0)
              if #next == 0 then break end
              redis.call('ZREM', KEYS[1], next[1])
              redis.call('ZADD', KEYS[2], now + lease, next[1])
            end
            redis.call('PEXPIRE', KEYS[1], retention)
            redis.call('PEXPIRE', KEYS[2], retention)
            local state = redis.call('ZSCORE', KEYS[2], ARGV[5]) and 'admitted' or 'queued'
            local position = 0
            if state == 'queued' then
              local rank = redis.call('ZRANK', KEYS[1], ARGV[5])
              if rank then position = rank + 1 else state = 'expired' end
            end
            return state .. '|' .. position
            """, String.class);
    private static final DefaultRedisScript<String> READ_AND_PROMOTE = new DefaultRedisScript<>("""
            local now = tonumber(ARGV[1])
            local capacity = tonumber(ARGV[2])
            local lease = tonumber(ARGV[3])
            local retention = tonumber(ARGV[4])
            redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
            while redis.call('ZCARD', KEYS[2]) < capacity do
              local next = redis.call('ZRANGE', KEYS[1], 0, 0)
              if #next == 0 then break end
              redis.call('ZREM', KEYS[1], next[1])
              redis.call('ZADD', KEYS[2], now + lease, next[1])
            end
            local state = redis.call('ZSCORE', KEYS[2], ARGV[5]) and 'admitted' or 'queued'
            local position = 0
            if state == 'queued' then
              local rank = redis.call('ZRANK', KEYS[1], ARGV[5])
              if rank then position = rank + 1 else return 'expired|0' end
            end
            redis.call('PEXPIRE', KEYS[1], retention)
            redis.call('PEXPIRE', KEYS[2], retention)
            return state .. '|' .. position
            """, String.class);
    private static final DefaultRedisScript<Long> VALIDATE = new DefaultRedisScript<>("""
            local expiry = redis.call('ZSCORE', KEYS[1], ARGV[1])
            if not expiry or tonumber(expiry) <= tonumber(ARGV[2]) then return 0 end
            return 1
            """, Long.class);
    private static final DefaultRedisScript<Long> RELEASE_AND_PROMOTE = new DefaultRedisScript<>("""
            redis.call('ZREM', KEYS[2], ARGV[1])
            local now = tonumber(ARGV[2])
            local capacity = tonumber(ARGV[3])
            local lease = tonumber(ARGV[4])
            while redis.call('ZCARD', KEYS[2]) < capacity do
              local next = redis.call('ZRANGE', KEYS[1], 0, 0)
              if #next == 0 then break end
              redis.call('ZREM', KEYS[1], next[1])
              redis.call('ZADD', KEYS[2], now + lease, next[1])
            end
            return 1
            """, Long.class);

    private final StringRedisTemplate redis;
    private final MeterRegistry metrics;
    private final int registrationCapacity;
    private final int checkoutCapacity;
    private final int maximumQueuedTickets;
    private final Duration admissionLease;

    public WaitingRoomService(
            StringRedisTemplate redis,
            MeterRegistry metrics,
            @Value("${app.waiting-room.registration-capacity:100}") int registrationCapacity,
            @Value("${app.waiting-room.checkout-capacity:100}") int checkoutCapacity,
            @Value("${app.waiting-room.maximum-queued-tickets:10000}") int maximumQueuedTickets,
            @Value("${app.waiting-room.admission-lease:PT5M}") Duration admissionLease) {
        if (registrationCapacity < 1 || registrationCapacity > 10_000
                || checkoutCapacity < 1 || checkoutCapacity > 10_000
                || maximumQueuedTickets < 1 || maximumQueuedTickets > 100_000
                || admissionLease.isNegative() || admissionLease.isZero()
                || admissionLease.compareTo(Duration.ofHours(1)) > 0) {
            throw new IllegalArgumentException(
                    "Waiting-room capacities, queue size, or admission lease are outside supported bounds");
        }
        this.redis = redis;
        this.metrics = metrics;
        this.registrationCapacity = registrationCapacity;
        this.checkoutCapacity = checkoutCapacity;
        this.maximumQueuedTickets = maximumQueuedTickets;
        this.admissionLease = admissionLease;
    }

    public Ticket join(Flow flow, UUID ticketId) {
        return evaluate(flow, ticketId.toString(), true);
    }

    public Ticket status(Flow flow, UUID ticketId) {
        return evaluate(flow, ticketId.toString(), false);
    }

    public boolean isAdmitted(Flow flow, String ticketId) {
        Long admitted = redis.execute(VALIDATE, List.of(activeKey(flow)),
                ticketId, Long.toString(System.currentTimeMillis()));
        return Long.valueOf(1).equals(admitted);
    }

    public void complete(Flow flow, String ticketId) {
        Long released = redis.execute(RELEASE_AND_PROMOTE,
                List.of(queueKey(flow), activeKey(flow)),
                ticketId, Long.toString(System.currentTimeMillis()),
                Integer.toString(capacity(flow)), Long.toString(admissionLease.toMillis()));
        if (!Long.valueOf(1).equals(released)) {
            throw new IllegalStateException("Waiting-room admission could not be released");
        }
    }

    private Ticket evaluate(Flow flow, String ticketId, boolean enqueue) {
        String result;
        if (enqueue) {
            result = redis.execute(QUEUE_AND_PROMOTE,
                    List.of(queueKey(flow), activeKey(flow), sequenceKey(flow)),
                    Long.toString(System.currentTimeMillis()), Integer.toString(capacity(flow)),
                    Long.toString(admissionLease.toMillis()), Long.toString(QUEUE_RETENTION),
                    ticketId, Integer.toString(maximumQueuedTickets));
        } else {
            result = redis.execute(READ_AND_PROMOTE,
                    List.of(queueKey(flow), activeKey(flow)),
                    Long.toString(System.currentTimeMillis()), Integer.toString(capacity(flow)),
                    Long.toString(admissionLease.toMillis()), Long.toString(QUEUE_RETENTION),
                    ticketId);
        }
        if (result == null) {
            throw new IllegalStateException("Waiting-room status was empty");
        }
        String[] parts = result.split("\\|", 2);
        String state = parts[0];
        int position = Integer.parseInt(parts[1]);
        metrics.counter("shop_waiting_room_checks_total", "flow", flow.path(), "state", state).increment();
        return new Ticket(ticketId, state, position, 3);
    }

    private int capacity(Flow flow) {
        return flow == Flow.REGISTRATION ? registrationCapacity : checkoutCapacity;
    }

    private static String queueKey(Flow flow) {
        return flowKey(flow) + ":queue";
    }

    private static String activeKey(Flow flow) {
        return flowKey(flow) + ":active";
    }

    private static String sequenceKey(Flow flow) {
        return flowKey(flow) + ":sequence";
    }

    private static String flowKey(Flow flow) {
        return "shop:waiting:v1:{" + flow.path() + "}";
    }

    public enum Flow {
        REGISTRATION("registration"),
        CHECKOUT("checkout");

        private final String path;

        Flow(String path) {
            this.path = path;
        }

        public String path() {
            return path;
        }

        public static Flow fromPath(String path) {
            for (Flow flow : values()) {
                if (flow.path.equals(path)) return flow;
            }
            throw new IllegalArgumentException("Unsupported waiting-room flow");
        }
    }

    public record Ticket(String ticketId, String state, int position, int retryAfterSeconds) {}
}
