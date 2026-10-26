package com.ccdesktunnel.mobile;
import org.junit.Test;
import static org.junit.Assert.*;
import java.security.MessageDigest;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.tls.HandshakeCertificates;
import okhttp3.tls.HeldCertificate;
public class PinnedTlsTest {
    private String pin(HeldCertificate c) throws Exception {StringBuilder b=new StringBuilder();for(byte v:MessageDigest.getInstance("SHA-256").digest(c.certificate().getEncoded()))b.append(String.format("%02x",v));return b.toString();}
    @Test public void explicitCertificatePinWorksWithoutIpSanAndRejectsAnotherCertificate() throws Exception {
        HeldCertificate cert=new HeldCertificate.Builder().commonName("my private tunnel").build();
        try(MockWebServer server=new MockWebServer()){
            server.useHttps(new HandshakeCertificates.Builder().heldCertificate(cert).build().sslSocketFactory(),false);server.enqueue(new MockResponse().setBody("ready"));server.start();
            OkHttpClient trusted=PinnedTls.client(pin(cert));
            try(okhttp3.Response response=trusted.newCall(new Request.Builder().url(server.url("/health")).build()).execute()){assertEquals("ready",response.body().string());}
            try {PinnedTls.client("00".repeat(32)).newCall(new Request.Builder().url(server.url("/health")).build()).execute();fail("Mismatched pin accepted");}catch(javax.net.ssl.SSLException expected){}
            try {PinnedTls.client("").newCall(new Request.Builder().url(server.url("/health")).build()).execute();fail("Untrusted certificate accepted");}catch(javax.net.ssl.SSLException expected){}
        }
    }
    @Test public void validationRejectsCredentialUrlsAndCleartext() {
        for(String url:new String[]{"ws://localhost/ws","https://example.com","wss://u:p@example.com/ws","wss://example.com/ws?token=secret","wss://example.com/ws#token"})try{PinnedTls.address(url);fail(url);}catch(IllegalArgumentException expected){}
        assertEquals("wss://127.0.0.1:8787/ws",PinnedTls.address("wss://127.0.0.1:8787/ws"));
        assertEquals("ab".repeat(32),PinnedTls.fingerprint("sha256 Fingerprint="+String.join(":",java.util.Collections.nCopies(32,"AB"))));
        try{PinnedTls.fingerprint("11:22");fail();}catch(IllegalArgumentException expected){}
    }
}
