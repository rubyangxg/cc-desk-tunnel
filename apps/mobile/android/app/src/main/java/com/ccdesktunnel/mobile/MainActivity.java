package com.ccdesktunnel.mobile;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.view.WindowInsets;
import androidx.webkit.WebViewAssetLoader;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;
import org.json.JSONArray;
import org.json.JSONObject;

public final class MainActivity extends Activity {
    private static final String ORIGIN="https://appassets.androidplatform.net";
    private WebView web;
    private ProfileStore profiles;
    private boolean destroyed;
    private final Map<String,Channel> channels=new ConcurrentHashMap<>();
    private static final class Channel {
        final String id;
        final JSONObject profile;
        final OkHttpClient client;
        final Map<String,String> status=new ConcurrentHashMap<>();
        WebSocket socket;
        final AtomicBoolean authenticated=new AtomicBoolean(false);
        Channel(String id,JSONObject profile,OkHttpClient client){this.id=id;this.profile=profile;this.client=client;}
        void close(){if(socket!=null)socket.cancel();client.connectionPool().evictAll();client.dispatcher().executorService().shutdown();}
    }
    @Override public void onCreate(Bundle saved){
        super.onCreate(saved);
        if(Build.VERSION.SDK_INT>=33)getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,this::back);
        try {profiles=new ProfileStore(this);} catch(Exception e){new AlertDialog.Builder(this).setTitle("无法读取连接配置").setMessage("手机安全存储不可用，请检查设备锁屏设置后重试。").setPositiveButton("关闭",(d,w)->finish()).show();return;}
        NotificationManager manager=getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel("tasks","任务提醒",NotificationManager.IMPORTANCE_DEFAULT));
        web=new WebView(this);setContentView(web);
        web.setOnApplyWindowInsetsListener((view,insets)->{
            if(Build.VERSION.SDK_INT>=30){android.graphics.Insets bars=insets.getInsets(WindowInsets.Type.systemBars()|WindowInsets.Type.ime());view.setPadding(bars.left,bars.top,bars.right,bars.bottom);return WindowInsets.CONSUMED;}
            view.setPadding(insets.getSystemWindowInsetLeft(),insets.getSystemWindowInsetTop(),insets.getSystemWindowInsetRight(),insets.getSystemWindowInsetBottom());return insets.consumeSystemWindowInsets();
        });
        WebSettings settings=web.getSettings();settings.setJavaScriptEnabled(true);settings.setDomStorageEnabled(false);settings.setAllowFileAccess(false);settings.setAllowContentAccess(false);settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);settings.setJavaScriptCanOpenWindowsAutomatically(false);settings.setSupportMultipleWindows(false);settings.setSafeBrowsingEnabled(true);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        WebViewAssetLoader loader=new WebViewAssetLoader.Builder().addPathHandler("/assets/",new WebViewAssetLoader.AssetsPathHandler(this)).build();
        web.setWebViewClient(new WebViewClient(){
            @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest request){
                WebResourceResponse response=loader.shouldInterceptRequest(request.getUrl());
                if(response==null) return new WebResourceResponse("text/plain","UTF-8",403,"Blocked",new HashMap<>(),new java.io.ByteArrayInputStream(new byte[0]));
                Map<String,String> headers=new HashMap<>();headers.put("Content-Security-Policy","default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'");headers.put("X-Content-Type-Options","nosniff");response.setResponseHeaders(headers);return response;
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){
                if(request.getUrl().toString().equals(ORIGIN+"/assets/index.html"))return false;
                if(request.hasGesture())openExternal(request.getUrl().toString());return true;
            }
        });
        web.addJavascriptInterface(new Bridge(),"MobileNative");web.loadUrl(ORIGIN+"/assets/index.html");
    }
    private boolean notifications(){return getPreferences(MODE_PRIVATE).getBoolean("notifications",false)&&getSystemService(NotificationManager.class).areNotificationsEnabled()&&(Build.VERSION.SDK_INT<33||checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)==PackageManager.PERMISSION_GRANTED);}
    private void notifyTask(Channel c,JSONObject frame){
        try {
            String type=frame.optString("type");
            if(type.equals("ready")){JSONArray sessions=frame.getJSONArray("sessions");for(int i=0;i<sessions.length();i++){JSONObject s=sessions.getJSONObject(i);JSONObject r=s.optJSONObject("activeRun");c.status.put(s.getString("id"),r==null?"idle":r.optString("status"));}return;}
            if(!type.equals("session.updated"))return;
            JSONObject s=frame.getJSONObject("session"),r=s.optJSONObject("activeRun");String id=s.getString("id"),next=r==null?"idle":r.optString("status"),old=c.status.put(id,next);
            if(!notifications()||old==null||old.equals(next))return;
            String title=next.equals("awaiting_approval")?"任务需要确认":next.equals("idle")&&!old.equals("idle")?"任务已结束":null;
            if(title==null)return;
            Intent intent=new Intent(this,MainActivity.class);intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP|Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent pending=PendingIntent.getActivity(this,0,intent,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
            Notification note=new Notification.Builder(this,"tasks").setSmallIcon(R.drawable.ic_launcher).setContentTitle(title).setContentText(s.optString("title","打开应用查看会话")).setContentIntent(pending).setAutoCancel(true).setVisibility(Notification.VISIBILITY_PRIVATE).build();
            getSystemService(NotificationManager.class).notify((c.profile.optString("id")+id).hashCode(),note);
        }catch(Exception ignored){}
    }
    private void openExternal(String url){try{Uri uri=Uri.parse(url);if(!"https".equals(uri.getScheme())&&!"http".equals(uri.getScheme()))return;startActivity(new Intent(Intent.ACTION_VIEW,uri));}catch(Exception ignored){}}
    private void emit(JSONObject message){runOnUiThread(()->{if(!destroyed&&web!=null)web.evaluateJavascript("window.__nativeReceive && window.__nativeReceive("+JSONObject.quote(message.toString())+")",null);});}
    private void event(String id,String name,String data,int code){try{emit(new JSONObject().put("id",id).put("event",name).put("data",data).put("code",code));}catch(Exception ignored){}}
    private void open(String id,String profileId) throws Exception {
        if(channels.containsKey(id)||channels.size()>=20)throw new IllegalStateException("连接数量过多，请关闭后重试。");
        JSONObject profile=profiles.get(profileId);OkHttpClient client=PinnedTls.client(profile.getString("fingerprint"));Channel channel=new Channel(id,profile,client);channels.put(id,channel);
        channel.socket=client.newWebSocket(new Request.Builder().url(profile.getString("url")).build(),new WebSocketListener(){
            private boolean current(){return channels.get(id)==channel;}
            @Override public void onOpen(WebSocket socket,Response response){if(current())event(id,"open","",0);else socket.cancel();}
            @Override public void onMessage(WebSocket socket,String text){if(!current())return;if(text.length()>2*1024*1024){socket.close(1009,"Frame too large");return;}try{notifyTask(channel,new JSONObject(text));}catch(Exception ignored){}event(id,"message",text,0);}
            @Override public void onMessage(WebSocket socket,ByteString bytes){socket.close(1003,"Text only");}
            @Override public void onClosing(WebSocket socket,int code,String reason){socket.close(code,reason);}
            @Override public void onClosed(WebSocket socket,int code,String reason){finish(code,reason);}
            @Override public void onFailure(WebSocket socket,Throwable error,Response response){if(!current())return;event(id,"error",error instanceof javax.net.ssl.SSLException?"TLS 校验失败，请核对证书指纹及服务器证书。":"连接失败，请检查地址与网络。",0);finish(1006,"");}
            private void finish(int code,String reason){if(!channels.remove(id,channel))return;event(id,"close",reason,code);channel.close();}
        });
    }
    private final class Bridge {
        @JavascriptInterface public void postMessage(String raw){
            if(raw==null||raw.length()>300000)return;
            runOnUiThread(()->{
                String id="";
                try{
                    if(destroyed||web==null||web.getUrl()==null||!web.getUrl().equals(ORIGIN+"/assets/index.html"))return;
                    JSONObject call=new JSONObject(raw);id=call.getString("id");String method=call.getString("method");JSONObject args=call.optJSONObject("args");if(args==null)args=new JSONObject();Object result=JSONObject.NULL;
                    switch(method){
                        case "profiles.list":result=profiles.list(notifications());break;
                        case "profiles.save":result=profiles.save(args);break;
                        case "profiles.remove":profiles.remove(args.getString("id"));break;
                        case "socket.open":open(args.getString("socketId"),args.getString("profileId"));break;
                        case "socket.close":{Channel c=channels.remove(args.getString("socketId"));if(c!=null)c.close();break;}
                        case "socket.send":{
                            Channel c=channels.get(args.getString("socketId"));if(c==null||c.socket==null)throw new IllegalStateException("连接已关闭。");
                            JSONObject frame=new JSONObject(args.getString("data"));String type=frame.optString("type");
                            if(type.startsWith("tunnel."))throw new IllegalArgumentException("手机不建立执行隧道。");
                            if(type.equals("auth")){
                                if(!c.authenticated.compareAndSet(false,true))throw new IllegalStateException("已经发送认证。");
                                frame.put("token",c.profile.getString("token"));frame.put("tunnel",false);frame.put("deviceName","Android 手机");
                            }else if(!c.authenticated.get())throw new IllegalStateException("请先认证。");
                            if(type.equals("device")){frame.put("id",profiles.list(false).getString("deviceId"));frame.remove("platform");}
                            if(!c.socket.send(frame.toString()))throw new IllegalStateException("连接中断，请检查会话确认消息是否送达。");break;
                        }
                        case "background":moveTaskToBack(true);break;
                        case "external":openExternal(args.getString("url"));break;
                        case "notifications":{
                            boolean enabled=args.getBoolean("enabled");getPreferences(MODE_PRIVATE).edit().putBoolean("notifications",enabled).apply();
                            if(enabled&&Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},1);
                            result=notifications();break;
                        }
                        default:throw new IllegalArgumentException("不支持的操作。");
                    }
                    emit(new JSONObject().put("id",id).put("ok",true).put("result",result));
                }catch(Exception error){try{emit(new JSONObject().put("id",id).put("ok",false).put("error",error.getMessage()==null?"操作失败，请重试。":error.getMessage()));}catch(Exception ignored){}}
            });
        }
    }
    @Override public void onRequestPermissionsResult(int code,String[] permissions,int[] results){super.onRequestPermissionsResult(code,permissions,results);if(web!=null)web.evaluateJavascript("document.dispatchEvent(new Event('visibilitychange'))",null);}
    private void back(){if(web!=null)web.evaluateJavascript("window.dispatchEvent(new Event('mobile-back'))",null);else super.onBackPressed();}
    @Override public void onBackPressed(){back();}
    @Override protected void onDestroy(){destroyed=true;for(Channel c:channels.values())c.close();channels.clear();if(web!=null){web.removeJavascriptInterface("MobileNative");web.destroy();web=null;}super.onDestroy();}
}
