/*
 * =========================================================================================
 * ESTUFA INTELIGENTE - CÓDIGO PRINCIPAL PARA ARDUINO UNO
 * Arquivo: estufa_hardware.ino
 * =========================================================================================
 * 
 * Este sketch roda no ARDUINO UNO e gerencia os sensores e relés da estufa.
 * A comunicação remota é feita através do Adaptador Wi-Fi ESP-01 conectado via Serial.
 *
 * OTIMIZADO PARA A MEMÓRIA RAM DO ARDUINO UNO (2 KB SRAM):
 *  - Uso intensivo da macro F() para preservar a memória SRAM.
 *  - Buffers estáticos compactos para evitar fragmentação de memória heap.
 *
 * ESQUEMA DE LIGAÇÃO DOS PINOS NO ARDUINO UNO:
 *  - Pino Digital 2 (RX)  <--- Conectar no TX do ESP-01
 *  - Pino Digital 3 (TX)  ---> Conectar no RX do ESP-01 (utilizar divisor de tensão 5V -> 3.3V)
 *  - Pino Digital 4       <--- Sensor DHT11 (Pino de Dados)
 *  - Pino Digital 5       ---> Relé 1 (Bomba de Irrigação)
 *  - Pino Digital 6       ---> Relé 2 (Ventoinha / Cooler)
 *  - Pino Digital 7       <--- Sensor Boia de Nível (INPUT_PULLUP)
 *  - Pino Analógico A0    <--- Sensor Higrômetro do Solo Analógico
 *
 * BIBLIOTECAS NECESSÁRIAS (Instalar via Gerenciador de Bibliotecas da Arduino IDE):
 *  1. "DHT sensor library" por Adafruit
 *  2. "Adafruit Unified Sensor" por Adafruit
 * =========================================================================================
 */

#include <SoftwareSerial.h>
#include <DHT.h>

// =========================================================================================
// 1. PINAGEM E CONFIGURAÇÕES
// =========================================================================================
// Comunicação Serial com o Adaptador Wi-Fi ESP-01
#define PIN_ESP_RX       2   // Arduino RX (recebe do TX do ESP-01)
#define PIN_ESP_TX       3   // Arduino TX (envia para o RX do ESP-01)

// Sensores e Atuadores
#define PIN_DHT          4   // Sensor DHT11
#define PIN_RELE_BOMBA   5   // Relé Bomba de Água
#define PIN_RELE_VENT    6   // Relé Ventoinha / Cooler
#define PIN_BOIA_AGUA    7   // Sensor Boia de Nível
#define PIN_SOLO_ADC     A0  // Higrômetro Analógico de Solo

#define TIPO_DHT DHT11
DHT dht(PIN_DHT, TIPO_DHT);

// Comunicação serial por software com o ESP-01 a 9600 baud
SoftwareSerial espSerial(PIN_ESP_RX, PIN_ESP_TX);

// Lógica de acionamento do módulo relé (normalmente LOW = Ligado, HIGH = Desligado)
const uint8_t RELE_LIGADO    = LOW;
const uint8_t RELE_DESLIGADO = HIGH;

// =========================================================================================
// 2. VARIÁVEIS DE ESTADO
// =========================================================================================
bool estadoBomba = false;
bool estadoVentoinha = false;

// Intervalo de leitura e envio periódico (3000 ms = 3 segundos)
unsigned long ultimoEnvio = 0;
const unsigned long INTERVALO_ENVIO = 3000;

// Calibração do Higrômetro de Solo no Arduino Uno (ADC 10 bits: 0 a 1023)
const int SOLO_VALOR_SECO  = 850;   // Leitura no solo seco/ar
const int SOLO_VALOR_UMIDO = 350;   // Leitura com terra bem úmida

// Buffer de recepção de comandos do ESP-01
char bufferCmd[32];
uint8_t idxCmd = 0;

// =========================================================================================
// 3. LEITURA DOS SENSORES (COMPACTA E EFICIENTE EM RAM)
// =========================================================================================

// Calcula a porcentagem de umidade do solo (0 a 100%)
int lerUmidadeSolo() {
  int raw = analogRead(PIN_SOLO_ADC);
  int clamped = constrain(raw, SOLO_VALOR_UMIDO, SOLO_VALOR_SECO);
  int pct = map(clamped, SOLO_VALOR_SECO, SOLO_VALOR_UMIDO, 0, 100);
  return constrain(pct, 0, 100);
}

// Lê os sensores e envia o JSON para o Adaptador ESP-01 transmitir via MQTT
void enviarTelemetria() {
  float temp = dht.readTemperature();
  float humAr = dht.readHumidity();

  // Tratamento se a leitura do DHT11 falhar momentaneamente
  if (isnan(temp)) temp = 25.0;
  if (isnan(humAr)) humAr = 55.0;

  int humSolo = lerUmidadeSolo();

  // Boia: com INPUT_PULLUP, LOW = água OK, HIGH = nível crítico
  bool boiaOk = (digitalRead(PIN_BOIA_AGUA) == LOW);

  // Envia a telemetria com prefixo "DATA:" para o ESP-01 encaminhar ao Broker MQTT
  // Usamos F() para economizar os preciosos 2KB de RAM do Arduino Uno
  espSerial.print(F("DATA:{\"temp\":"));
  espSerial.print(temp, 1);
  espSerial.print(F(",\"umidade_ar\":"));
  espSerial.print((int)humAr);
  espSerial.print(F(",\"umidade_solo\":"));
  espSerial.print(humSolo);
  espSerial.print(F(",\"nivel_agua\":\""));
  espSerial.print(boiaOk ? F("OK") : F("CRITICO"));
  espSerial.print(F("\",\"bomba\":"));
  espSerial.print(estadoBomba ? 1 : 0);
  espSerial.print(F(",\"ventoinha\":"));
  espSerial.print(estadoVentoinha ? 1 : 0);
  espSerial.println(F("}"));

  // Debug no Monitor Serial do Arduino (USB)
  Serial.print(F("[TELEMETRIA] Temp: "));
  Serial.print(temp, 1);
  Serial.print(F("C | Ar: "));
  Serial.print((int)humAr);
  Serial.print(F("% | Solo: "));
  Serial.print(humSolo);
  Serial.print(F("% | Boia: "));
  Serial.print(boiaOk ? F("OK") : F("CRIT"));
  Serial.print(F(" | Bomba: "));
  Serial.print(estadoBomba ? F("ON") : F("OFF"));
  Serial.print(F(" | Fan: "));
  Serial.println(estadoVentoinha ? F("ON") : F("OFF"));
}

// =========================================================================================
// 4. PROCESSAMENTO DE COMANDOS RECEBIDOS DO ESP-01
// =========================================================================================
void processarComando(const char* cmd) {
  Serial.print(F("[COMANDO RECEBIDO DO ESP-01]: "));
  Serial.println(cmd);

  bool mudouEstado = false;

  if (strstr(cmd, "bomba_toggle") != NULL || strstr(cmd, "BOMBA") != NULL) {
    estadoBomba = !estadoBomba;
    digitalWrite(PIN_RELE_BOMBA, estadoBomba ? RELE_LIGADO : RELE_DESLIGADO);
    mudouEstado = true;
    Serial.print(F("-> Bomba alterada para: "));
    Serial.println(estadoBomba ? F("LIGADA") : F("DESLIGADA"));
  }
  else if (strstr(cmd, "ventoinha_toggle") != NULL || strstr(cmd, "VENT") != NULL) {
    estadoVentoinha = !estadoVentoinha;
    digitalWrite(PIN_RELE_VENT, estadoVentoinha ? RELE_LIGADO : RELE_DESLIGADO);
    mudouEstado = true;
    Serial.print(F("-> Ventoinha alterada para: "));
    Serial.println(estadoVentoinha ? F("LIGADA") : F("DESLIGADA"));
  }

  // Se o estado mudou ou se recebeu solicitação de status, envia telemetria imediatamente
  if (mudouEstado || strstr(cmd, "status") != NULL || strstr(cmd, "STATUS") != NULL) {
    enviarTelemetria();
  }
}

// =========================================================================================
// 5. SETUP E LOOP PRINCIPAL
// =========================================================================================
void setup() {
  // Serial USB para monitoramento no PC
  Serial.begin(115200);
  delay(200);
  Serial.println(F("\n=============================================="));
  Serial.println(F(" ESTUFA INTELIGENTE - ARDUINO UNO + ESP-01"));
  Serial.println(F("=============================================="));

  // Comunicação serial com o adaptador ESP-01
  espSerial.begin(9600);

  // Configuração dos Pinos dos Relés
  pinMode(PIN_RELE_BOMBA, OUTPUT);
  pinMode(PIN_RELE_VENT, OUTPUT);
  digitalWrite(PIN_RELE_BOMBA, RELE_DESLIGADO);
  digitalWrite(PIN_RELE_VENT, RELE_DESLIGADO);

  // Sensor de Boia (resistor interno pull-up)
  pinMode(PIN_BOIA_AGUA, INPUT_PULLUP);

  // Inicializa o sensor DHT11
  dht.begin();

  Serial.println(F("[ARDUINO] Sensores e relés inicializados."));
  Serial.println(F("[ARDUINO] Aguardando mensagens do Adaptador ESP-01..."));
}

void loop() {
  // 1. Escuta comandos seriais vindos do ESP-01
  while (espSerial.available() > 0) {
    char c = espSerial.read();
    if (c == '\n' || c == '\r') {
      if (idxCmd > 0) {
        bufferCmd[idxCmd] = '\0';
        processarComando(bufferCmd);
        idxCmd = 0;
      }
    } else {
      if (idxCmd < sizeof(bufferCmd) - 1) {
        bufferCmd[idxCmd++] = c;
      }
    }
  }

  // 2. Envio periódico da telemetria para o ESP-01
  unsigned long agora = millis();
  if (agora - ultimoEnvio >= INTERVALO_ENVIO) {
    ultimoEnvio = agora;
    enviarTelemetria();
  }
}
