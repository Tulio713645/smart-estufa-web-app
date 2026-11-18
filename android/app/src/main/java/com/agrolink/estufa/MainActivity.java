package com.agrolink.estufa;

import android.os.Bundle;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.app.Activity;
import android.graphics.Color;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothSocket;
import android.content.pm.PackageManager;
import android.Manifest;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.util.Set;
import java.util.UUID;

public class MainActivity extends Activity {
    private WebView webView;
    private BluetoothAdapter bluetoothAdapter;
    private BluetoothSocket bluetoothSocket;
    private OutputStream outputStream;
    private InputStream inputStream;
    private Thread workerThread;
    private volatile boolean isConnected = false;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    // UUID padrão para comunicação Serial Port Profile (SPP) do HC-05
    private static final UUID SPP_UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    private static final int PERMISSION_REQUEST_CODE = 101;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Barra de status nativa do sistema sempre visível (Horário, Bateria, Conectividade)
        Window window = getWindow();
        window.clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            window.setStatusBarColor(Color.parseColor("#06100b"));
            window.setNavigationBarColor(Color.parseColor("#06100b"));
        }

        bluetoothAdapter = BluetoothAdapter.getDefaultAdapter();
        checkAndRequestPermissions();

        webView = new WebView(this);
        setContentView(webView);

        // Aceleração por hardware
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);

        WebSettings webSettings = webView.getSettings();
        webSettings.setJavaScriptEnabled(true);
        webSettings.setDomStorageEnabled(true);
        webSettings.setDatabaseEnabled(true);
        webSettings.setAllowFileAccess(true);
        webSettings.setAllowContentAccess(true);
        webSettings.setLoadWithOverviewMode(true);
        webSettings.setUseWideViewPort(true);
        webSettings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        webSettings.setCacheMode(WebSettings.LOAD_DEFAULT);

        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient());

        // Registra a ponte nativa de Bluetooth para o frontend JavaScript
        webView.addJavascriptInterface(new BluetoothBridge(), "AndroidBluetooth");

        // Carrega o frontend mobile do AgroLink
        webView.loadUrl("file:///android_asset/public/index.html");
    }

    private void checkAndRequestPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED ||
                checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{
                    Manifest.permission.BLUETOOTH_CONNECT,
                    Manifest.permission.BLUETOOTH_SCAN,
                    Manifest.permission.ACCESS_FINE_LOCATION
                }, PERMISSION_REQUEST_CODE);
            }
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION}, PERMISSION_REQUEST_CODE);
            }
        }
    }

    /**
     * Ponte JavaScript <-> Android para gerenciamento do Bluetooth HC-05
     */
    public class BluetoothBridge {

        @JavascriptInterface
        public boolean isBluetoothSupported() {
            return bluetoothAdapter != null;
        }

        @JavascriptInterface
        public boolean isBluetoothEnabled() {
            return bluetoothAdapter != null && bluetoothAdapter.isEnabled();
        }

        @JavascriptInterface
        public boolean isConnected() {
            return isConnected && bluetoothSocket != null && bluetoothSocket.isConnected();
        }

        @JavascriptInterface
        public String getPairedDevices() {
            JSONArray array = new JSONArray();
            if (bluetoothAdapter == null || !bluetoothAdapter.isEnabled()) {
                return array.toString();
            }

            try {
                Set<BluetoothDevice> pairedDevices = bluetoothAdapter.getBondedDevices();
                if (pairedDevices != null) {
                    for (BluetoothDevice device : pairedDevices) {
                        JSONObject obj = new JSONObject();
                        obj.put("name", device.getName() != null ? device.getName() : "Dispositivo Sem Nome");
                        obj.put("address", device.getAddress());
                        array.put(obj);
                    }
                }
            } catch (Exception e) {
                e.printStackTrace();
            }
            return array.toString();
        }

        @JavascriptInterface
        public void connect(final String macAddress) {
            if (bluetoothAdapter == null || !bluetoothAdapter.isEnabled()) {
                notifyStatusChange("error", "Bluetooth desativado no celular");
                return;
            }

            // Desconecta sessão anterior se existir
            disconnect();

            notifyStatusChange("connecting", "Conectando ao módulo HC-05 (" + macAddress + ")...");

            new Thread(new Runnable() {
                @Override
                public void run() {
                    try {
                        BluetoothDevice device = bluetoothAdapter.getRemoteDevice(macAddress);
                        // Cancela discovery para melhorar velocidade de conexão
                        bluetoothAdapter.cancelDiscovery();

                        bluetoothSocket = device.createRfcommSocketToServiceRecord(SPP_UUID);
                        bluetoothSocket.connect();

                        outputStream = bluetoothSocket.getOutputStream();
                        inputStream = bluetoothSocket.getInputStream();
                        isConnected = true;

                        notifyStatusChange("connected", device.getName() != null ? device.getName() : "HC-05");

                        // Inicia thread de escuta serial contínua
                        startListening();

                    } catch (Exception e) {
                        e.printStackTrace();
                        isConnected = false;
                        closeConnection();
                        notifyStatusChange("error", "Falha ao conectar: " + e.getMessage());
                    }
                }
            }).start();
        }

        @JavascriptInterface
        public void disconnect() {
            new Thread(new Runnable() {
                @Override
                public void run() {
                    closeConnection();
                    notifyStatusChange("disconnected", "Desconectado do módulo Bluetooth.");
                }
            }).start();
        }

        @JavascriptInterface
        public boolean send(String data) {
            if (!isConnected || outputStream == null) {
                return false;
            }
            try {
                byte[] bytes = (data.endsWith("\n") ? data : data + "\n").getBytes("UTF-8");
                outputStream.write(bytes);
                outputStream.flush();
                return true;
            } catch (Exception e) {
                e.printStackTrace();
                closeConnection();
                notifyStatusChange("disconnected", "Erro de transmissão serial.");
                return false;
            }
        }
    }

    private void startListening() {
        workerThread = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    BufferedReader reader = new BufferedReader(new InputStreamReader(inputStream, "UTF-8"));
                    String line;
                    while (isConnected && (line = reader.readLine()) != null) {
                        final String data = line.trim();
                        if (!data.isEmpty()) {
                            mainHandler.post(new Runnable() {
                                @Override
                                public void run() {
                                    if (webView != null) {
                                        webView.evaluateJavascript("if(window.onBluetoothDataReceived){window.onBluetoothDataReceived(" + JSONObject.quote(data) + ");}", null);
                                    }
                                }
                            });
                        }
                    }
                } catch (Exception e) {
                    if (isConnected) {
                        e.printStackTrace();
                        closeConnection();
                        notifyStatusChange("disconnected", "Conexão Bluetooth interrompida.");
                    }
                }
            }
        });
        workerThread.start();
    }

    private void closeConnection() {
        isConnected = false;
        try {
            if (inputStream != null) inputStream.close();
        } catch (Exception ignored) {}
        try {
            if (outputStream != null) outputStream.close();
        } catch (Exception ignored) {}
        try {
            if (bluetoothSocket != null) bluetoothSocket.close();
        } catch (Exception ignored) {}
        bluetoothSocket = null;
        inputStream = null;
        outputStream = null;
    }

    private void notifyStatusChange(final String status, final String message) {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                if (webView != null) {
                    webView.evaluateJavascript("if(window.onBluetoothStatusChanged){window.onBluetoothStatusChanged(" + 
                        JSONObject.quote(status) + ", " + JSONObject.quote(message) + ");}", null);
                }
            }
        });
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        closeConnection();
        super.onDestroy();
    }
}
