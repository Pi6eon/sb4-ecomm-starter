package com.example.shop.discovery;

import com.example.shop.catalog.CatalogService;
import com.example.shop.catalog.Product;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import java.util.concurrent.TimeUnit;

@RestController
@RequestMapping("/api/v1/discovery")
public class DiscoveryController {
    private final CatalogService catalog;
    private final String publicWebUrl;

    public DiscoveryController(
            CatalogService catalog,
            @Value("${app.public-web-url}") String publicWebUrl) {
        this.catalog = catalog;
        this.publicWebUrl = publicWebUrl.replaceAll("/+$", "");
    }

    @GetMapping(value = "/sitemap.xml", produces = MediaType.APPLICATION_XML_VALUE)
    ResponseEntity<String> sitemap() {
        StringBuilder xml = new StringBuilder("""
                <?xml version="1.0" encoding="UTF-8"?>
                <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
                  <url><loc>%s/</loc></url>
                """.formatted(escape(publicWebUrl)));
        for (Product product : catalog.findActive()) {
            xml.append("<url><loc>")
                    .append(escape(publicWebUrl + "/products/" + product.id()))
                    .append("</loc></url>");
        }
        xml.append("</urlset>");
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(5, TimeUnit.MINUTES).cachePublic())
                .contentType(MediaType.APPLICATION_XML)
                .body(xml.toString());
    }

    @GetMapping(value = "/robots.txt", produces = MediaType.TEXT_PLAIN_VALUE)
    ResponseEntity<String> robots() {
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(1, TimeUnit.HOURS).cachePublic())
                .contentType(MediaType.TEXT_PLAIN)
                .body("User-agent: *\nAllow: /\nDisallow: /cart\nDisallow: /account\nSitemap: "
                        + publicWebUrl + "/sitemap.xml\n");
    }

    private static String escape(String value) {
        return value.replace("&", "&amp;").replace("<", "&lt;")
                .replace(">", "&gt;").replace("\"", "&quot;").replace("'", "&apos;");
    }
}
