package com.example.shop.orders;

import io.micrometer.core.instrument.MeterRegistry;
import org.apache.kafka.clients.admin.NewTopic;
import org.apache.kafka.clients.admin.AdminClientConfig;
import org.apache.kafka.clients.producer.ProducerConfig;
import org.apache.kafka.common.serialization.StringSerializer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.core.DefaultKafkaProducerFactory;
import org.springframework.kafka.core.ProducerFactory;
import org.springframework.kafka.core.KafkaAdmin;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.concurrent.TimeUnit;
import java.util.HashMap;
import java.util.Map;

@Component
class OrderOutboxPublisher {
    private static final Logger log = LoggerFactory.getLogger(OrderOutboxPublisher.class);
    private final OrderOutboxRepository outbox;
    private final KafkaTemplate<String, String> kafka;
    private final MeterRegistry metrics;
    private final String topic;
    private final int batchSize;
    private final Duration lease;

    OrderOutboxPublisher(
            OrderOutboxRepository outbox,
            KafkaTemplate<String, String> kafka,
            MeterRegistry metrics,
            @Value("${app.events.order-outbox.topic:shop.order-events.v1}") String topic,
            @Value("${app.events.order-outbox.batch-size:50}") int batchSize,
            @Value("${app.events.order-outbox.lease:PT1M}") Duration lease) {
        this.outbox = outbox;
        this.kafka = kafka;
        this.metrics = metrics;
        this.topic = topic;
        this.batchSize = batchSize;
        this.lease = lease;
    }

    @Scheduled(fixedDelayString = "${app.events.order-outbox.poll-delay:PT1S}")
    void publishPendingEvents() {
        for (OrderOutboxRepository.OutboxEvent event : outbox.claimBatch(batchSize, lease.toSeconds())) {
            try {
                kafka.send(topic, event.aggregateId().toString(), event.payload())
                        .get(5, TimeUnit.SECONDS);
                outbox.markPublished(event.id());
                metrics.counter("shop_order_outbox_published_total", "event_type", event.eventType()).increment();
            } catch (InterruptedException ex) {
                Thread.currentThread().interrupt();
                retry(event, ex);
                return;
            } catch (Exception ex) {
                retry(event, ex);
            }
        }
    }

    private void retry(OrderOutboxRepository.OutboxEvent event, Exception failure) {
        String errorCode = failure.getClass().getSimpleName();
        outbox.releaseForRetry(event.id(), event.attempts(), errorCode);
        metrics.counter("shop_order_outbox_failures_total", "event_type", event.eventType()).increment();
        log.warn("Order outbox publish failed eventId={} failureType={}", event.id(), errorCode);
    }
}

@Configuration
@EnableScheduling
class OrderOutboxConfiguration {
    @Bean
    ProducerFactory<String, String> orderEventProducerFactory(
            @Value("${spring.kafka.bootstrap-servers:${KAFKA_BOOTSTRAP_SERVERS:kafka:9092}}") String bootstrapServers,
            @Value("${KAFKA_SECURITY_PROTOCOL:}") String securityProtocol,
            @Value("${KAFKA_SASL_MECHANISM:}") String saslMechanism,
            @Value("${KAFKA_SASL_JAAS_CONFIG:}") String saslJaasConfig) {
        Map<String, Object> properties = kafkaProperties(
                bootstrapServers, securityProtocol, saslMechanism, saslJaasConfig);
        properties.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
        properties.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        properties.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        properties.put(ProducerConfig.ACKS_CONFIG, "all");
        properties.put(ProducerConfig.RETRIES_CONFIG, 10);
        properties.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
        return new DefaultKafkaProducerFactory<>(properties);
    }

    @Bean
    KafkaTemplate<String, String> orderEventKafkaTemplate(ProducerFactory<String, String> orderEventProducerFactory) {
        return new KafkaTemplate<>(orderEventProducerFactory);
    }

    @Bean
    KafkaAdmin orderEventKafkaAdmin(
            @Value("${spring.kafka.bootstrap-servers:${KAFKA_BOOTSTRAP_SERVERS:kafka:9092}}") String bootstrapServers,
            @Value("${KAFKA_SECURITY_PROTOCOL:}") String securityProtocol,
            @Value("${KAFKA_SASL_MECHANISM:}") String saslMechanism,
            @Value("${KAFKA_SASL_JAAS_CONFIG:}") String saslJaasConfig) {
        KafkaAdmin admin = new KafkaAdmin(kafkaProperties(
                bootstrapServers, securityProtocol, saslMechanism, saslJaasConfig));
        admin.setFatalIfBrokerNotAvailable(false);
        return admin;
    }

    @Bean
    NewTopic orderEventsTopic(@Value("${app.events.order-outbox.topic:shop.order-events.v1}") String topic) {
        return new NewTopic(topic, 3, (short) 1);
    }

    private static Map<String, Object> kafkaProperties(
            String bootstrapServers, String securityProtocol, String saslMechanism, String saslJaasConfig) {
        Map<String, Object> properties = new HashMap<>();
        properties.put(AdminClientConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
        if (!securityProtocol.isBlank()) {
            properties.put("security.protocol", securityProtocol);
            properties.put("sasl.mechanism", saslMechanism);
            properties.put("sasl.jaas.config", saslJaasConfig);
        }
        return properties;
    }
}
