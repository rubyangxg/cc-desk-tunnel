package com.ccdesktunnel.mobile;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import android.content.Context;
import android.content.Intent;
import android.webkit.WebView;
import android.view.ViewGroup;
import java.nio.file.Files;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;
@RunWith(AndroidJUnit4.class) public class StartupTest {
    @Test public void packagedAppLoadsItsRealJavascriptAndNativeBridge() throws Exception {
        var instrumentation=InstrumentationRegistry.getInstrumentation();Context context=instrumentation.getTargetContext();
        Intent intent=new Intent(context,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);MainActivity activity=(MainActivity)instrumentation.startActivitySync(intent);
        try {
            String text="";
            for(int i=0;i<40;i++){
                CountDownLatch done=new CountDownLatch(1);AtomicReference<String> result=new AtomicReference<>("");
                instrumentation.runOnMainSync(()->{ViewGroup root=activity.findViewById(android.R.id.content);((WebView)root.getChildAt(0)).evaluateJavascript("document.body.innerText",value->{result.set(value);done.countDown();});});
                assertTrue(done.await(5,TimeUnit.SECONDS));text=result.get();if(text.contains("从手机接着做"))break;Thread.sleep(250);
            }
            assertTrue(text,text.contains("从手机接着做"));assertFalse(text,text.contains("请安装 Android"));
        } finally {instrumentation.runOnMainSync(activity::finish);}
    }
    @Test public void connectionSecretsNeverAppearInPublicProfilesOrPlaintextPreferences() throws Exception {
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();ProfileStore store=new ProfileStore(context);
        String token="instrumentation-test-token-"+java.util.UUID.randomUUID();
        JSONObject profile=store.save(new JSONObject().put("name","Test").put("url","wss://127.0.0.1:8787/ws").put("fingerprint","").put("token",token));
        try {
            assertFalse(profile.toString().contains(token));assertFalse(store.list(false).toString().contains(token));assertEquals(token,store.get(profile.getString("id")).getString("token"));
            java.io.File file=new java.io.File(context.getApplicationInfo().dataDir,"shared_prefs/connections.xml");assertFalse(new String(Files.readAllBytes(file.toPath()),StandardCharsets.UTF_8).contains(token));
        }finally{store.remove(profile.getString("id"));}
    }
}
