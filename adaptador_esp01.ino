/*
 * =========================================================================================
 * ESTUFA INTELIGENTE - FIRMWARE DO ADAPTADOR WI-FI ESP-01 (ESP8266)
 * Arquivo: adaptador_esp01.ino
 * =========================================================================================
 * 
 * Este sketch roda no módulo ESP-01 (ESP8266) atuando como ADAPTADOR WI-FI & MQTT da estufa.
 * Ele gerencia a conexão com a rede Wi-Fi residencial e com o Broker MQTT na Nuvem (HiveMQ),
 * fazendo a ponte de comunicação serial com o ARDUINO UNO.
 *
 * ESQUEMA DE LIGAÇÃO DOS PINOS DO ESP-01 AO ARDUINO UNO:
 *  - ESP-01 VCC / CH_PD (EN) -> Conectar a 3.3V (Fonte com corrente suficiente ~300mA)
 *  - ESP-01 GND              -> Conectar ao GND comum do Arduino
 *  - ESP-01 TX (GPIO 1)      -> Conectar ao Pino Digital 2 (RX) do Arduino Uno
 *  - ESP-01 RX (GPIO 3)      <-- Conectar ao Pino Digital 3 (TX) do Arduino Uno (via divisor 5V->3.3V)
 *
 * BIBLIOTECAS NECESSÁRIAS (Instalar via Gerenciador de Bibliotecas da Arduino IDE):
 *  1. "PubSubClient" por Nick O'Leary
 *  2. Pacote de Placas "esp8266" instalado na Arduino IDE
 *
 * TÓPICOS MQTT AUTOMÁTICOS BASEADOS NO DEVICE_ID:
 *  - Publicação de Sensores: estufa/ESTUFA-A1B2/sensores
 *  - Recepção de Comandos:   estufa/ESTUFA-A1B2/comandos
 * =========================================================================================
 */

#include <ESP8266WiFi.h>
#include <PubSubClient.h>

// =========================================================================================
// 1. CÓDIGO DA ESTUFA (ID ÚNICO DE PAREAMENTO COM O APP WEB)
// =========================================================================================
// Este código deve ser idêntico ao digitado no modal do aplicativo Web!
#define DEVICE_ID "ESTUFA-A1B2"

// =========================================================================================
// 2. CONFIGURAÇÃO DA REDE WI-FI E BROKER MQTT
// =========================================================================================
// Substitua pelo nome e senha da rede Wi-Fi da sua residência:
const char* WIFI_SSID = "SUA_REDE_WIFI";
const char* WIFI_PASS = "SUA_SENHA_WIFI";

// Broker MQTT público e gratuito (compatível com a porta nativa TCP 1883)
const char* MQTT_BROKER = "broker.hivemq.com";
const int   MQTT_PORT   = 1883;

// Tópicos MQTT padronizados
const char* TOPICO_SENSORES = "estufa/" DEVICE_ID "/sensores";
const char* TOPICO_COMANDOS = "estufa/" DEVICE_ID "/comandos";

WiFiClient espClient;
PubSubClient mqttClient(espClient);

// Buffer para leitura serial vinda do Arduino Uno
char bufferSerial[160];
uint8_t idxSerial = 0;

// =========================================================================================
// 3. CALLBACK MQTT: RECEBE COMANDOS DO APP WEB E ENVIA AO ARDUINO UNO
// =========================================================================================
void callbackMQTT(char* topic, byte* payload, unsigned int length) {
  String comando = "";
  for (unsigned int i = 0; i < length; i++) {
    comando += (char)payload[i];
  }

  // Encaminha o comando recebido do Web App para o Arduino Uno via Serial
  if (comando.indexOf("bomba_toggle") >= 0) {
    Serial.println("CMD:bomba_toggle");
  } 
  else if (comando.indexOf("ventoinha_toggle") >= 0) {
    Serial.println("CMD:ventoinha_toggle");
  } 
  else if (comando.indexOf("status") >= 0) {
    Serial.println("CMD:status");
  }
}

// =========================================================================================
// 4. GERENCIAMENTO DE CONEXÃO WI-FI E MQTT
// =========================================================================================
void conectarWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  int tentativas = 0;
  while (WiFi.status() != WL_CONNECTED && tentativas < 30) {
    delay(500);
    tentativas++;
  }
}

void conectarMQTT() {
  while (!mqttClient.connected()) {
    if (WiFi.status() != WL_CONNECTED) {
      conectarWiFi();
    }

    // Client ID único com base no ID da estufa
    String clientId = "ESP01_" + String(DEVICE_ID) + "_" + String(random(0xffff), HEX);

    if (mqttClient.connect(clientId.c_str())) {
      // Inscreve-se no tópico de comandos da estufa
      mqttClient.subscribe(TOPICO_COMANDOS);

      // Pede leitura imediata ao Arduino Uno
      Serial.println("CMD:status");
    } else {
      delay(3000);
    }
  }
}

// =========================================================================================
// 5. PROCESSAMENTO DE TELEMETRIA VINDA DO ARDUINO UNO
// =========================================================================================
void processarLinhaArduino(const char* linha) {
  // O Arduino Uno envia a telemetria com o prefixo "DATA:{"temp":...}"
  if (strncmp(linha, "DATA:", 5) == 0) {
    const char* jsonPayload = linha + 5;
    
    // Publica no Broker MQTT com flag retain = true para entrega imediata na Web
    if (mqttClient.connected()) {
      mqttClient.publish(TOPICO_SENSORES, jsonPayload, true);
    }
  }
}

// =========================================================================================
// 6. SETUP E LOOP PRINCIPAL
// =========================================================================================
void setup() {
  // Comunicação serial com o Arduino Uno a 9600 baud
  Serial.begin(9600);
  delay(100);

  // Conecta ao Wi-Fi residencial
  conectarWiFi();

  // Configura o Broker MQTT
  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setCallback(callbackMQTT);
}

void loop() {
  // Mantém a conexão MQTT ativa
  if (!mqttClient.connected()) {
    conectarMQTT();
  }
  mqttClient.loop();

  // Lê mensagens seriais enviadas pelo Arduino Uno
  while (Serial.available() > 0) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (idxSerial > 0) {
        bufferSerial[idxSerial] = '\0';
        processarLinhaArduino(bufferSerial);
        idxSerial = 0;
      }
    } else {
      if (idxSerial < sizeof(bufferSerial) - 1) {
        bufferSerial[idxSerial++] = c;
      }
    }
  }
}
