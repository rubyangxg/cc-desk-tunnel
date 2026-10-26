package com.ccdesktunnel.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONArray;
import org.json.JSONObject;

final class ProfileStore {
    private final SharedPreferences prefs;
    private final SecretKey key;
    ProfileStore(Context context) throws Exception {
        prefs=context.getSharedPreferences("connections",Context.MODE_PRIVATE);
        KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);
        String alias="cc-desk-tunnel-connections-v1";
        if(!store.containsAlias(alias)) {
            KeyGenerator generator=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());generator.generateKey();
        }
        key=(SecretKey)store.getKey(alias,null);
        if(!prefs.contains("deviceId")) prefs.edit().putString("deviceId",UUID.randomUUID().toString()).commit();
    }
    synchronized JSONArray read() throws Exception {
        String data=prefs.getString("encrypted",null);if(data==null)return new JSONArray();
        JSONObject sealed=new JSONObject(data);
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE,key,new GCMParameterSpec(128,Base64.decode(sealed.getString("iv"),Base64.NO_WRAP)));
        return new JSONArray(new String(cipher.doFinal(Base64.decode(sealed.getString("data"),Base64.NO_WRAP)),StandardCharsets.UTF_8));
    }
    private void write(JSONArray data) throws Exception {
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key);
        JSONObject sealed=new JSONObject().put("iv",Base64.encodeToString(cipher.getIV(),Base64.NO_WRAP)).put("data",Base64.encodeToString(cipher.doFinal(data.toString().getBytes(StandardCharsets.UTF_8)),Base64.NO_WRAP));
        if(!prefs.edit().putString("encrypted",sealed.toString()).commit())throw new IllegalStateException("保存失败。");
    }
    synchronized JSONObject get(String id) throws Exception {
        JSONArray all=read();for(int i=0;i<all.length();i++)if(all.getJSONObject(i).getString("id").equals(id))return all.getJSONObject(i);
        throw new IllegalArgumentException("连接不存在，请重新添加。");
    }
    static JSONObject publicProfile(JSONObject p) throws Exception { return new JSONObject().put("id",p.getString("id")).put("name",p.getString("name")).put("url",p.getString("url")).put("fingerprint",p.getString("fingerprint")); }
    synchronized JSONObject list(boolean notifications) throws Exception {
        JSONArray visible=new JSONArray(),all=read();for(int i=0;i<all.length();i++)visible.put(publicProfile(all.getJSONObject(i)));
        return new JSONObject().put("profiles",visible).put("deviceId",prefs.getString("deviceId","")).put("notifications",notifications);
    }
    synchronized JSONObject save(JSONObject input) throws Exception {
        JSONArray all=read();String id=input.optString("id","");
        if(id.isEmpty()) { if(all.length()>=10)throw new IllegalArgumentException("最多保存 10 个服务器。");id=UUID.randomUUID().toString(); }
        String name=input.getString("name").trim(),token=input.optString("token","").trim();
        if(name.isEmpty()||name.length()>80)throw new IllegalArgumentException("请填写服务器名称。");
        JSONArray next=new JSONArray();JSONObject old=null;
        for(int i=0;i<all.length();i++){JSONObject p=all.getJSONObject(i);if(p.getString("id").equals(id))old=p;else next.put(p);}
        if(token.isEmpty()&&old!=null) token=old.getString("token");
        if(token.length()<24||token.length()>512)throw new IllegalArgumentException("服务凭据长度不正确。");
        JSONObject value=new JSONObject().put("id",id).put("name",name).put("url",PinnedTls.address(input.getString("url"))).put("fingerprint",PinnedTls.fingerprint(input.optString("fingerprint",""))).put("token",token);
        next.put(value);write(next);return publicProfile(value);
    }
    synchronized void remove(String id) throws Exception {JSONArray all=read(),next=new JSONArray();for(int i=0;i<all.length();i++)if(!all.getJSONObject(i).getString("id").equals(id))next.put(all.getJSONObject(i));write(next);}
}
