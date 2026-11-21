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
    private Thread connectThread;
    private volatile boolean isConnected = false;
    private volatile boolean isConnecting = false;
    private volatile boolean autoReconnect = false;
    private volatile boolean permissionsGranted = false;
    private String lastMacAddress = null;
    private String lastDeviceName = null;
    private int reconnectAttempts = 0;
    private static final int MAX_RECONNECT_ATTEMPTS = 6;
    private static final long RECONNECT_DELAY_MS = 4000;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Handler reconnectHandler = new Handler(Looper.getMainLooper());

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

    private boolean hasBtPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        }
        return true;
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
            } else {
                permissionsGranted = true;
            }
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION}, PERMISSION_REQUEST_CODE);
            } else {
                permissionsGranted = true;
            }
        } else {
            permissionsGranted = true;
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != PERMISSION_REQUEST_CODE) return;

        boolean granted = true;
        for (int r : grantResults) {
            if (r != PackageManager.PERMISSION_GRANTED) { granted = false; break; }
        }
        permissionsGranted = granted;

        if (granted) {
            notifyStatusChange("permission_granted", "Permissões de Bluetooth concedidas.");
        } else {
            notifyStatusChange("permission_denied",
                "Permissões de Bluetooth negadas. Conceda em Configurações > Apps > AgroLink > Permissões.");
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
            if (bluetoothAdapter == null) return false;
            try {
                return bluetoothAdapter.isEnabled();
            } catch (SecurityException e) {
                return false;
            }
        }

        @JavascriptInterface
        public boolean isConnected() {
            if (!isConnected || bluetoothSocket == null) return false;
            try {
                return bluetoothSocket.isConnected();
            } catch (SecurityException e) {
                return false;
            }
        }

        @JavascriptInterface
        public boolean hasPermissions() {
            return hasBtPermissions();
        }

        @JavascriptInterface
        public void requestPermissions() {
            checkAndRequestPermissions();
        }

        @JavascriptInterface
        public String getPairedDevices() {
            JSONArray array = new JSONArray();
            if (bluetoothAdapter == null) return array.toString();
            try {
                if (!bluetoothAdapter.isEnabled()) return array.toString();
                Set<BluetoothDevice> pairedDevices = bluetoothAdapter.getBondedDevices();
                if (pairedDevices != null) {
                    for (BluetoothDevice device : pairedDevices) {
                        JSONObject obj = new JSONObject();
                        String name = null;
                        try { name = device.getName(); } catch (SecurityException ignored) {}
                        obj.put("name", name != null ? name : "Dispositivo Sem Nome");
                        obj.put("address", device.getAddress());
                        array.put(obj);
                    }
                }
            } catch (SecurityException e) {
                notifyStatusChange("permission_denied", "Sem permissão BLUETOOTH_CONNECT para listar dispositivos.");
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
            if (!hasBtPermissions()) {
                notifyStatusChange("permission_denied", "Conceda as permissões de Bluetooth para conectar.");
                checkAndRequestPermissions();
                return;
            }

            lastMacAddress = macAddress;
            autoReconnect = true;
            reconnectAttempts = 0;

            startConnect(macAddress);
        }

        @JavascriptInterface
        public void disconnect() {
            autoReconnect = false;
            reconnectHandler.removeCallbacksAndMessages(null);
            closeConnection();
            notifyStatusChange("disconnected", "Desconectado do módulo Bluetooth.");
        }

        @JavascriptInterface
        public void reconnect() {
            // Garante limpeza total antes de reconectar
            autoReconnect = false;
            reconnectHandler.removeCallbacksAndMessages(null);
            closeConnection();

            if (lastMacAddress != null) {
                autoReconnect = true;
                reconnectAttempts = 0;
                // Pequeno delay para garantir que socket anterior foi fechado
                reconnectHandler.postDelayed(new Runnable() {
                    @Override
                    public void run() {
                        startConnect(lastMacAddress);
                    }
                }, 500);
            } else {
                notifyStatusChange("error", "Nenhum dispositivo para reconectar.");
            }
        }

        @JavascriptInterface
        public boolean send(String data) {
            final OutputStream os = outputStream;
            if (!isConnected || os == null) {
                return false;
            }
            try {
                // Comandos sempre terminam em '\n' (protocolo do firmware)
                byte[] bytes = (data.endsWith("\n") ? data : data + "\n").getBytes("UTF-8");
                synchronized (this) {
                    os.write(bytes);
                    os.flush();
                }
                return true;
            } catch (Exception e) {
                e.printStackTrace();
                onConnectionLost("Erro de transmissão serial.");
                return false;
            }
        }
    }

    private void startConnect(final String macAddress) {
        // Evita duas conexões concorrentes: encerra qualquer tentativa anterior
        isConnecting = false;
        if (connectThread != null && connectThread.isAlive()) {
            connectThread.interrupt();
            try { connectThread.join(1000); } catch (InterruptedException ignored) {}
        }
        closeConnection();

        isConnecting = true;
        notifyStatusChange("connecting", "Conectando ao módulo HC-05 (" + macAddress + ")...");

        connectThread = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    BluetoothDevice device = bluetoothAdapter.getRemoteDevice(macAddress);
                    String name = null;
                    try { name = device.getName(); } catch (SecurityException se) { name = null; }
                    lastDeviceName = name;

                    // Cancela discovery para melhorar velocidade de conexão
                    try { bluetoothAdapter.cancelDiscovery(); } catch (SecurityException ignored) {}

                    BluetoothSocket socket = device.createRfcommSocketToServiceRecord(SPP_UUID);
                    socket.connect();

                    // Se uma desconexão aconteceu durante o connect, descarta o socket
                    if (!isConnecting) {
                        try { socket.close(); } catch (Exception ignored) {}
                        return;
                    }

                    bluetoothSocket = socket;
                    outputStream = socket.getOutputStream();
                    inputStream = socket.getInputStream();
                    isConnected = true;
                    isConnecting = false;
                    reconnectAttempts = 0;

                    String nome = name != null ? name : "HC-05";
                    notifyStatusChange("connected", nome);

                    // Inicia thread de escuta serial contínua
                    startListening();

                } catch (Exception e) {
                    e.printStackTrace();
                    isConnecting = false;
                    closeConnection();
                    notifyStatusChange("error", "Falha ao conectar: " + e.getMessage());
                    scheduleReconnect();
                }
            }
        });
        connectThread.start();
    }

    private void scheduleReconnect() {
        if (!autoReconnect || lastMacAddress == null) return;
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            notifyStatusChange("disconnected", "Não foi possível reconectar ao HC-05. Toque em Conectar.");
            autoReconnect = false;
            return;
        }
        reconnectAttempts++;
        notifyStatusChange("connecting", "Reconectando ao HC-05 (tentativa " + reconnectAttempts + ")...");
        reconnectHandler.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (autoReconnect && !isConnected && lastMacAddress != null) {
                    startConnect(lastMacAddress);
                }
            }
        }, RECONNECT_DELAY_MS);
    }

    private void onConnectionLost(String message) {
        boolean wasConnected = isConnected;
        closeConnection();
        notifyStatusChange("disconnected", message);
        if (wasConnected) {
            scheduleReconnect();
        }
    }

    private void startListening() {
        final InputStream is = inputStream;
        workerThread = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    BufferedReader reader = new BufferedReader(new InputStreamReader(is, "UTF-8"));
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
                        onConnectionLost("Conexão Bluetooth interrompida.");
                    }
                }
            }
        });
        workerThread.start();
    }

    private synchronized void closeConnection() {
        isConnected = false;
        isConnecting = false;
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
        if (webView != null) {
            // Tenta delegar o back press para o JavaScript (SPA navigation)
            webView.evaluateJavascript("(function() { " +
                "if (typeof window.handleAndroidBackPress === 'function') { " +
                "return window.handleAndroidBackPress(); " +
                "} " +
                "return false; " +
                "})()", value -> {
                    if (value != null && "true".equals(value.replace("\"", ""))) {
                        // JavaScript tratou o back press (fechou modal, voltou para lista, etc.)
                        return;
                    } else if (webView.canGoBack()) {
                        // Fallback para histórico do WebView
                        webView.goBack();
                    } else {
                        // Nenhum tratamento: sai do app
                        runOnUiThread(() -> super.onBackPressed());
                    }
                });
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        autoReconnect = false;
        reconnectHandler.removeCallbacksAndMessages(null);
        closeConnection();
        super.onDestroy();
    }
}