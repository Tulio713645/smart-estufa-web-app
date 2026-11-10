/*
 * =========================================================================================
 * ESTUFA INTELIGENTE - CÓDIGO IoT MQTT PARA ESP32 / ESP8266
 * Arquivo: estufa_hardware.ino
 * =========================================================================================
 * 
 * Este sketch conecta o ESP32 à sua rede Wi-Fi e ao Broker MQTT na Nuvem (HiveMQ).
 * Ele publica a telemetria dos sensores em tempo real e escuta comandos remotos
 * enviados pelo Aplicativo Web SPA de qualquer lugar do mundo!
 *
 * BIBLIOTECAS NECESSÁRIAS (Instalar via Gerenciador de Bibliotecas na Arduino IDE):
 *  1. "PubSubClient" por Nick O'Leary
 *  2. "DHT sensor library" por Adafruit
 *  3. "Adafruit Unified Sensor" por Adafruit
 *
 * COMO FUNCIONA A COMUNICAÇÃO:
 *  - ESP32 se conecta ao HiveMQ via porta nativa TCP 1883: broker.hivemq.com:1883
 *  - O App Web se conecta ao mesmo HiveMQ via WebSocket Seguro: wss://broker.hivemq.com:8884/mqtt
 *  - O HiveMQ encaminha as mensagens entre o navegador e o ESP32 instantaneamente!
 *
 * TÓPICOS MQTT:
 *  - Publicação (ESP32 -> Web):  "estufa/Tulio/sensores"
 *  - Inscrição  (Web -> ESP32):  "estufa/Tulio/comandos"
 * =========================================================================================
 */

#if defined(ESP32)
  #include <WiFi.h>
#elif defined(ESP8266)
  #include <ESP8266WiFi.h>
#else
  #error "Este código foi projetado para ESP32 ou ESP8266."
#endif

#include <PubSubClient.h>
#include <DHT.h>

// =========================================================================================
// 1. CONFIGURAÇÕES DA REDE WI-FI E DO BROKER MQTT
// =========================================================================================
// Substitua pelo nome e senha do Wi-Fi da sua casa:
const char* WIFI_SSID = "SUA_REDE_WIFI";
const char* WIFI_PASS = "SUA_SENHA_WIFI";

// Broker MQTT público e gratuito (mesmo configurado no App Web)
const char* MQTT_BROKER = "broker.hivemq.com";
const int   MQTT_PORT   = 1883;

// Tópicos MQTT (Devem coincidir com o configurado no painel da aplicação Web)
const char* TOPICO_SENSORES = "estufa/Tulio/sensores";
const char* TOPICO_COMANDOS = "estufa/Tulio/comandos";

// =========================================================================================
// 2. PINAGEM DOS SENSORES E ATUADORES
// =========================================================================================
#if defined(ESP32)
  #define PINO_DHT         4      // GPIO 4  -> Sensor DHT11 (Dados)
  #define PINO_SOLO_ADC    34     // GPIO 34 -> Higrômetro de Solo Analógico (ADC1)
  #define PINO_BOIA_AGUA   18     // GPIO 18 -> Sensor Boia do Reservatório
  #define PINO_RELE_BOMBA  26     // GPIO 26 -> Relé da Bomba de Água
  #define PINO_RELE_VENT   27     // GPIO 27 -> Relé da Ventoinha / Cooler
#elif defined(ESP8266)
  #define PINO_DHT         D4     // GPIO 2  -> Sensor DHT11
  #define PINO_SOLO_ADC    A0     // ADC 0   -> Higrômetro de Solo
  #define PINO_BOIA_AGUA   D7     // GPIO 13 -> Sensor Boia
  #define PINO_RELE_BOMBA  D1     // GPIO 5  -> Relé Bomba
  #define PINO_RELE_VENT   D2     // GPIO 4  -> Relé Ventoinha
#endif

#define TIPO_DHT DHT11
DHT dht(PINO_DHT, TIPO_DHT);

// Lógica de acionamento do módulo de relé:
// A maioria dos módulos de relé para Arduino aciona em nível LÓGICO BAIXO (LOW = Ligado, HIGH = Desligado).
// Se o seu módulo acionar com nível HIGH, inverta os valores abaixo:
const int RELE_LIGADO    = LOW;
const int RELE_DESLIGADO = HIGH;

// =========================================================================================
// 3. VARIÁVEIS DE ESTADO E CLIENTES
// =========================================================================================
WiFiClient espClient;
PubSubClient mqttClient(espClient);

bool estadoBomba = false;
bool estadoVentoinha = false;

// Intervalo de publicação automática dos sensores (3000 ms = 3 segundos)
unsigned long ultimoEnvio = 0;
const unsigned long INTERVALO_ENVIO = 3000;

// Calibração do Sensor de Umidade do Solo
#if defined(ESP32)
  const int SOLO_VALOR_SECO = 3200;   // Leitura no ar/solo seco (ADC 12 bits: 0 a 4095)
  const int SOLO_VALOR_UMIDO = 1400;  // Leitura na água/solo bem úmido
#else
  const int SOLO_VALOR_SECO = 850;    // Leitura ESP8266 (ADC 10 bits: 0 a 1023)
  const int SOLO_VALOR_UMIDO = 350;
#endif

// =========================================================================================
// 4. FUNÇÕES DE LEITURA DOS SENSORES
// =========================================================================================

// Converte a leitura analógica do solo em porcentagem (0 a 100%)
int lerUmidadeSoloPercentual() {
  int leituraADC = analogRead(PINO_SOLO_ADC);
  int leituraClamped = constrain(leituraADC, SOLO_VALOR_UMIDO, SOLO_VALOR_SECO);
  int porcentagem = map(leituraClamped, SOLO_VALOR_SECO, SOLO_VALOR_UMIDO, 0, 100);
  return constrain(porcentagem, 0, 100);
}

// Gera o JSON com a telemetria da estufa
String gerarPayloadSensores() {
  float temp = dht.readTemperature();
  float humAr = dht.readHumidity();

  // Tratamento se o DHT falhar momentaneamente
  if (isnan(temp)) temp = 25.0;
  if (isnan(humAr)) humAr = 55.0;

  int humSolo = lerUmidadeSoloPercentual();

  // Sensor de Boia (INPUT_PULLUP: LOW = água presente, HIGH = reservatório vazio)
  int leituraBoia = digitalRead(PINO_BOIA_AGUA);
  String nivelAgua = (leituraBoia == LOW) ? "OK" : "CRITICO";

  // Monta JSON exatamente como esperado pelo Web App
  String json = "{";
  json += "\"temp\":" + String(temp, 1) + ",";
  json += "\"umidade_ar\":" + String((int)humAr) + ",";
  json += "\"umidade_solo\":" + String(humSolo) + ",";
  json += "\"nivel_agua\":\"" + nivelAgua + "\",";
  json += "\"bomba\":" + String(estadoBomba ? 1 : 0) + ",";
  json += "\"ventoinha\":" + String(estadoVentoinha ? 1 : 0);
  json += "}";

  return json;
}

// Publica a telemetria via MQTT
void publicarSensores() {
  if (!mqttClient.connected()) return;

  String payload = gerarPayloadSensores();
  
  // Publica com retain = true para que qualquer cliente web receba o último valor assim que abrir!
  mqttClient.publish(TOPICO_SENSORES, payload.c_str(), true);
  
  Serial.print("[MQTT PUBLISH -> ");
  Serial.print(TOPICO_SENSORES);
  Serial.print("]: ");
  Serial.println(payload);
}

// =========================================================================================
// 5. RECEBIMENTO DE COMANDOS REMOTOS (MQTT CALLBACK)
// =========================================================================================
void callbackMQTT(char* topic, byte* payload, unsigned int length) {
  String mensagem = "";
  for (unsigned int i = 0; i < length; i++) {
    mensagem += (char)payload[i];
  }

  Serial.print("[MQTT RECEIVE <- ");
  Serial.print(topic);
  Serial.print("]: ");
  Serial.println(mensagem);

  bool alterouAtuador = false;

  // Comando: Alternar Bomba de Água
  if (mensagem.indexOf("bomba_toggle") >= 0 || mensagem.indexOf("\"atuador\":\"bomba\"") >= 0) {
    estadoBomba = !estadoBomba;
    digitalWrite(PINO_RELE_BOMBA, estadoBomba ? RELE_LIGADO : RELE_DESLIGADO);
    Serial.print("[ATUADOR] Bomba de Água: ");
    Serial.println(estadoBomba ? "LIGADA" : "DESLIGADA");
    alterouAtuador = true;
  }

  // Comando: Alternar Ventoinha
  if (mensagem.indexOf("ventoinha_toggle") >= 0 || mensagem.indexOf("\"atuador\":\"ventoinha\"") >= 0) {
    estadoVentoinha = !estadoVentoinha;
    digitalWrite(PINO_RELE_VENT, estadoVentoinha ? RELE_LIGADO : RELE_DESLIGADO);
    Serial.print("[ATUADOR] Ventoinha: ");
    Serial.println(estadoVentoinha ? "LIGADA" : "DESLIGADA");
    alterouAtuador = true;
  }

  // Se solicitou apenas leitura ("status") ou alterou atuador, publica o estado atual imediatamente!
  if (alterouAtuador || mensagem.indexOf("status") >= 0) {
    publicarSensores();
  }
}

// =========================================================================================
// 6. GERENCIAMENTO DE CONEXÃO WI-FI E MQTT
// =========================================================================================
void conectarWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  Serial.println();
  Serial.print("[WIFI] Conectando à rede: ");
  Serial.println(WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  int tentativas = 0;
  while (WiFi.status() != WL_CONNECTED && tentativas < 30) {
    delay(500);
    Serial.print(".");
    tentativas++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[WIFI] Conectado com sucesso!");
    Serial.print("[WIFI] Endereço IP Local: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\n[WIFI] Falha ao conectar. Verifique as credenciais no código.");
  }
}

void conectarMQTT() {
  while (!mqttClient.connected()) {
    if (WiFi.status() != WL_CONNECTED) {
      conectarWiFi();
    }

    Serial.print("[MQTT] Tentando conectar ao Broker: ");
    Serial.println(MQTT_BROKER);

    // Gera um Client ID aleatório único para evitar conflitos de sessão
    String clientId = "ESP32_Estufa_" + String(random(0xffff), HEX);

    if (mqttClient.connect(clientId.c_str())) {
      Serial.println("[MQTT] Conectado com sucesso à nuvem HiveMQ!");

      // Inscreve-se no tópico de comandos remotos
      mqttClient.subscribe(TOPICO_COMANDOS);
      Serial.print("[MQTT] Subscrito no tópico de comandos: ");
      Serial.println(TOPICO_COMANDOS);

      // Publica estado inicial
      publicarSensores();
    } else {
      Serial.print("[MQTT] Falha na conexão. Código de erro: ");
      Serial.print(mqttClient.state());
      Serial.println(". Nova tentativa em 4 segundos...");
      delay(4000);
    }
  }
}

// =========================================================================================
// 7. SETUP E LOOP PRINCIPAL
// =========================================================================================
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n=======================================================");
  Serial.println("  ESTUFA INTELIGENTE IoT - COMUNICAÇÃO MQTT CLOUD");
  Serial.println("=======================================================");

  // Configuração dos Pinos dos Relés
  pinMode(PINO_RELE_BOMBA, OUTPUT);
  pinMode(PINO_RELE_VENT, OUTPUT);
  digitalWrite(PINO_RELE_BOMBA, RELE_DESLIGADO);
  digitalWrite(PINO_RELE_VENT, RELE_DESLIGADO);

  // Configuração do Sensor de Boia (resistor interno pull-up)
  pinMode(PINO_BOIA_AGUA, INPUT_PULLUP);

  // Inicializa Sensor DHT11
  dht.begin();

  // Conecta ao Wi-Fi
  conectarWiFi();

  // Configura o Broker MQTT
  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setCallback(callbackMQTT);
}

void loop() {
  // Mantém a conexão MQTT ativa e processa mensagens recebidas
  if (!mqttClient.connected()) {
    conectarMQTT();
  }
  mqttClient.loop();

  // Publicação periódica dos dados dos sensores
  unsigned long agora = millis();
  if (agora - ultimoEnvio >= INTERVALO_ENVIO) {
    ultimoEnvio = agora;
    publicarSensores();
  }
}
