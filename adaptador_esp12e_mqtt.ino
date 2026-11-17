/*
 * =========================================================================================
 * AGROLINK - FIRMWARE ADAPTADOR WI-FI ESP-12E (ESP8266) COM MQTT SEGURO
 * Arquivo: adaptador_esp12e_mqtt.ino
 * =========================================================================================
 * 
 * Este código roda no microcontrolador ESP-12E (ESP8266) conectado ao Arduino Uno.
 * Ele atua como uma ponte de comunicação de rede sem fio (Wi-Fi) de alta velocidade,
 * publicando leituras e recebendo comandos via servidor MQTT Seguro EMQX Cloud.
 * 
 * Configurações da Rede e Broker MQTT:
 *  - Servidor: yfd21101.ala.us-east-1.emqxsl.com
 *  - Porta: 8883 (SSL/TLS MQTTS) ou 1883 (TCP)
 *  - Usuário: agro_user
 *  - Senha: thiago6767
 *  - Nome de Rede Local (AP Config): AgroLink-Estufa
 *  - Tópicos MQTT Isolados por Estufa:
 *      * agrolink/{id_estufa}/telemetria   (Publica dados dos sensores)
 *      * agrolink/{id_estufa}/comando      (Recebe comandos do App)
 *      * agrolink/{id_estufa}/status       (Publica estado online/offline e LWT)
 * 
 * Conexão Física com o Arduino Uno:
 *  - ESP-12E TX (GPIO1 / TXD0) ----> Pino 8 do Arduino Uno (RX)
 *  - ESP-12E RX (GPIO3 / RXD0) <---- Pino 9 do Arduino Uno (TX) [via divisor resistivo 5V -> 3.3V]
 *  - GND comum entre ESP-12E e Arduino Uno
 *  - Alimentação 3.3V estável (mínimo 500mA) no ESP-12E (VCC + CH_PD/EN em 3.3V)
 * =========================================================================================
 */

#include <ESP8266WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>

// --- IDENTIFICADOR DA ESTUFA (ISOLAMENTO DE MÚLTIPLAS UNIDADES) ---
// Altere este ID para cada unidade instalada (ex: estufa_01, estufa_tomate, estufa_02)
String idEstufa = "estufa_01";
String nomeAmigavel = "AgroLink-Estufa";

// --- CREDENCIAIS DO BROKER MQTT SEGURO (EMQX CLOUD) ---
const char* mqttServer   = "yfd21101.ala.us-east-1.emqxsl.com";
const int   mqttPort     = 8883; // Porta segura MQTTS
const char* mqttUser     = "agro_user";
const char* mqttPassword = "thiago6767";

// --- CONFIGURAÇÃO WI-FI PADRÃO (OU MODO AP SE DESCONECTADO) ---
// O usuário pode colocar as credenciais da rede da fazenda/residência aqui:
const char* defaultSSID = "SUA_REDE_WIFI";
const char* defaultPASS = "SUA_SENHA_WIFI";

// Nome da rede criada pelo ESP no modo de configuração:
const char* apSSID = "AgroLink-Estufa-Setup";

// Tópicos MQTT dinâmicos construídos no setup()
String topicoTelemetria;
String topicoComando;
String topicoStatus;

WiFiClientSecure espClient;
PubSubClient mqttClient(espClient);

// Buffers de comunicação Serial com o Arduino
String bufferSerialArduino = "";
unsigned long ultimoEnvioHeartbeat = 0;
bool modoConfigAtivo = false;

// =========================================================================================
// CALLBACK MQTT - RECEBE COMANDOS ENVIADOS PELO APLICATIVO AGROLINK
// =========================================================================================
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String mensagem = "";
  for (unsigned int i = 0; i < length; i++) {
    mensagem += (char)payload[i];
  }

  // Encaminha o comando recebido instantaneamente para o Arduino Uno via UART Serial
  Serial.println(mensagem);
}

// =========================================================================================
// RECONEXÃO MQTT COM LAST WILL AND TESTAMENT (LWT)
// =========================================================================================
void reconectarMQTT() {
  if (WiFi.status() != WL_CONNECTED) return;

  // Tenta conectar se ainda não estiver conectado
  if (!mqttClient.connected()) {
    String clientId = "AgroLinkNode-" + idEstufa + "-" + String(random(0xffff), HEX);

    // Mensagem de Testamento (LWT): Se o ESP cair de forma abrupta, o broker avisa o App que está offline
    String lwtTopic = topicoStatus;
    String lwtMessage = "{\"status\":\"offline\",\"id\":\"" + idEstufa + "\"}";

    if (mqttClient.connect(clientId.c_str(), mqttUser, mqttPassword, lwtTopic.c_str(), 1, true, lwtMessage.c_str())) {
      // Notifica o aplicativo que a estufa está Online
      String statusOnline = "{\"status\":\"online\",\"id\":\"" + idEstufa + "\",\"nome\":\"" + nomeAmigavel + "\"}";
      mqttClient.publish(topicoStatus.c_str(), statusOnline.c_str(), true);

      // Inscreve-se no tópico de comandos isolado desta estufa
      mqttClient.subscribe(topicoComando.c_str());

      // Notifica o Arduino Uno que estamos Online
      Serial.println(F("{\"status\":\"online\"}"));
    }
  }
}

// =========================================================================================
// MODO ACCESS POINT DE CONFIGURAÇÃO (SELECIONADO PELO BOTÃO FÍSICO 3S)
// =========================================================================================
void iniciarModoConfiguracao() {
  modoConfigAtivo = true;
  WiFi.disconnect();
  WiFi.mode(WIFI_AP);
  WiFi.softAP(apSSID);
  
  // Notifica o Arduino
  Serial.println(F("{\"ack\":\"modo_config\",\"ip\":\"192.168.4.1\"}"));
}

// =========================================================================================
// SETUP
// =========================================================================================
void setup() {
  // Inicializa comunicação serial com o Arduino Uno a 9600 baud
  Serial.begin(9600);
  delay(200);

  // Constrói tópicos MQTT isolados por estufa
  topicoTelemetria = "agrolink/" + idEstufa + "/telemetria";
  topicoComando    = "agrolink/" + idEstufa + "/comando";
  topicoStatus     = "agrolink/" + idEstufa + "/status";

  // Configura TLS/SSL seguro sem checagem de certificado rígida (para evitar expiração de CA em microcontrolador)
  espClient.setInsecure();

  mqttClient.setServer(mqttServer, mqttPort);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(512); // Buffer para JSON completo

  // Inicia Wi-Fi em modo Station (conecta ao roteador)
  WiFi.mode(WIFI_STA);
  WiFi.hostname(nomeAmigavel.c_str());
  WiFi.begin(defaultSSID, defaultPASS);

  // Habilita Watchdog do ESP8266
  ESP.wdtEnable(WDTO_8S);
}

// =========================================================================================
// LOOP PRINCIPAL
// =========================================================================================
void loop() {
  // Alimenta o Watchdog do ESP
  ESP.wdtFeed();

  // 1. Manutenção da conexão Wi-Fi e MQTT
  if (!modoConfigAtivo) {
    if (WiFi.status() == WL_CONNECTED) {
      if (!mqttClient.connected()) {
        reconectarMQTT();
      } else {
        mqttClient.loop();
      }
    }
  }

  // 2. Leitura de dados vindos do Arduino Uno pela porta Serial
  while (Serial.available() > 0) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (bufferSerialArduino.length() > 0) {
        bufferSerialArduino.trim();

        // Comando interno de configuração de rede vindo do botão físico do Arduino
        if (bufferSerialArduino.indexOf("modo_config") >= 0) {
          iniciarModoConfiguracao();
        }
        // Comando de desconexão manual vindo da proteção do botão físico
        else if (bufferSerialArduino.indexOf("desconectar") >= 0) {
          if (mqttClient.connected()) {
            String msgOff = "{\"status\":\"offline\",\"id\":\"" + idEstufa + "\"}";
            mqttClient.publish(topicoStatus.c_str(), msgOff.c_str(), true);
            mqttClient.disconnect();
          }
          WiFi.disconnect();
          Serial.println(F("{\"status\":\"offline\"}"));
        }
        // Se for telemetria de sensores ou confirmação de comando, publica no Broker MQTT!
        else if (bufferSerialArduino.startsWith("{") && bufferSerialArduino.endsWith("}")) {
          if (mqttClient.connected()) {
            // Se for telemetria periódica:
            if (bufferSerialArduino.indexOf("\"temp\":") >= 0) {
              mqttClient.publish(topicoTelemetria.c_str(), bufferSerialArduino.c_str());
            }
            // Se for confirmação de acionamento (ACK):
            else if (bufferSerialArduino.indexOf("\"ack\":") >= 0) {
              String topicoAck = "agrolink/" + idEstufa + "/ack";
              mqttClient.publish(topicoAck.c_str(), bufferSerialArduino.c_str());
            }
          }
        }

        bufferSerialArduino = "";
      }
    } else if (bufferSerialArduino.length() < 256) {
      bufferSerialArduino += c;
    }
  }
}
