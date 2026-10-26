package com.ccdesktunnel.mobile;

import java.net.URI;
import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import okhttp3.OkHttpClient;

/** A configured SHA256 pins the whole leaf certificate, including self-signed servers. */
public final class PinnedTls {
    public static String fingerprint(String value) {
        String pin = value.trim().replaceFirst("(?i)^sha256\\s*fingerprint\\s*=\\s*", "").replace(":", "").replace(" ", "").toLowerCase(Locale.ROOT);
        if (!pin.isEmpty() && !pin.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("SHA256 指纹应为 64 位十六进制字符。");
        return pin;
    }
    public static String address(String value) {
        URI u = URI.create(value.trim());
        if (!"wss".equals(u.getScheme()) || u.getHost() == null || u.getUserInfo() != null || u.getRawQuery() != null || u.getRawFragment() != null)
            throw new IllegalArgumentException("请输入 wss:// 地址，不要在地址中填写凭据。");
        return u.toString();
    }
    public static boolean matches(X509Certificate cert, String pin) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(cert.getEncoded());
            byte[] expected = new byte[32];
            if (pin.length() != 64) return false;
            for (int i=0; i<32; i++) expected[i]=(byte)Integer.parseInt(pin.substring(i*2,i*2+2),16);
            return MessageDigest.isEqual(digest, expected);
        } catch (Exception ignored) { return false; }
    }
    public static OkHttpClient client(String rawPin) throws Exception {
        String pin = fingerprint(rawPin);
        OkHttpClient.Builder builder = new OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(0, TimeUnit.SECONDS).pingInterval(20, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false);
        if (!pin.isEmpty()) {
            X509TrustManager trust = new X509TrustManager() {
                public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
                public void checkClientTrusted(X509Certificate[] chain, String auth) throws CertificateException { throw new CertificateException("Client certificates are not supported"); }
                public void checkServerTrusted(X509Certificate[] chain, String auth) throws CertificateException {
                    if (chain == null || chain.length == 0 || !matches(chain[0], pin)) throw new CertificateException("服务器证书指纹不匹配，请核对连接设置。");
                    chain[0].checkValidity();
                }
            };
            SSLContext ssl = SSLContext.getInstance("TLS"); ssl.init(null, new TrustManager[]{trust}, null);
            builder.sslSocketFactory(ssl.getSocketFactory(), trust);
            // Self-signed IP certificates may not contain an IP SAN. Identity is the explicitly supplied pin.
            builder.hostnameVerifier((hostname, session) -> {
                try { return matches((X509Certificate)session.getPeerCertificates()[0], pin); } catch (Exception e) { return false; }
            });
        }
        return builder.build();
    }
}
