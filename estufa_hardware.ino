/*
 * =========================================================================================
 * ESTUFA INTELIGENTE - CÓDIGO PRINCIPAL PARA ARDUINO UNO + DISPLAY LCD 16x2
 * Arquivo: estufa_hardware.ino
 * =========================================================================================
 * 
 * Este sketch roda no ARDUINO UNO e gerencia os sensores, relés e a TELA LCD da estufa.
 * A comunicação remota é feita através do Adaptador Wi-Fi ESP-01 conectado via Serial.
 *
 * RECURSOS DA TELA LCD 16x2:
 *  - Na Inicialização: Exibe o nome da estufa e o CÓDIGO DE PAREAMENTO (ex: ESTUFA-A1B2).
 *  - Na Conexão do App: Exibe a confirmação visual "✓ PAREADO COM SUCESSO!".
 *  - No Dia a Dia: Exibe Temperatura, Umidade do Ar, Umidade do Solo e Nível de Água.
 *  - Nos Comandos: Exibe na hora o status de acionamento ("BOMBA LIGADA", "COOLER LIGADO").
 *
 * ESQUEMA DE LIGAÇÃO DOS PINOS NO ARDUINO UNO:
 *  - Display LCD 16x2 com I2C:
 *      * SDA ➔ Pino Analógico A4 do Arduino Uno
 *      * SCL ➔ Pino Analógico A5 do Arduino Uno
 *      * VCC ➔ 5V | GND ➔ GND
 *  - Adaptador Wi-Fi ESP-01:
 *      * Pino Digital 2 (RX) <--- Conectar no TX do ESP-01
 *      * Pino Digital 3 (TX) ---> Conectar no RX do ESP-01 (via divisor 5V->3.3V)
 *  - Sensores & Relés:
 *      * Pino Digital 4      <--- Sensor DHT11 (Pino de Dados)
 *      * Pino Digital 5      ---> Relé 1 (Bomba de Irrigação)
 *      * Pino Digital 6      ---> Relé 2 (Ventoinha / Cooler)
 *      * Pino Digital 7      <--- Sensor Boia de Nível (INPUT_PULLUP)
 *      * Pino Analógico A0   <--- Sensor Higrômetro do Solo Analógico
 *      * Pino Digital 13     ---> LED de Status de Pareamento (Onboard)
 *
 * BIBLIOTECAS NECESSÁRIAS (Instalar via Gerenciador de Bibliotecas da Arduino IDE):
 *  1. "LiquidCrystal I2C" por Frank de Brabander (ou Marco Schwartz)
 *  2. "DHT sensor library" por Adafruit
 *  3. "Adafruit Unified Sensor" por Adafruit
 * =========================================================================================
 */

#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <SoftwareSerial.h>
#include <DHT.h>

// =========================================================================================
// 1. PINAGEM E CONFIGURAÇÕES
// =========================================================================================
#define CODIGO_ESTUFA    "ESTUFA-A1B2"  // Código padrão exibido no visor LCD

// Comunicação Serial com o Adaptador Wi-Fi ESP-01
#define PIN_ESP_RX       2   // Arduino RX (recebe do TX do ESP-01)
#define PIN_ESP_TX       3   // Arduino TX (envia para o RX do ESP-01)

// Sensores e Atuadores
#define PIN_DHT          4   // Sensor DHT11
#define PIN_RELE_BOMBA   5   // Relé Bomba de Água
#define PIN_RELE_VENT    6   // Relé Ventoinha / Cooler
#define PIN_BOIA_AGUA    7   // Sensor Boia de Nível
#define PIN_LED_STATUS   13  // LED Onboard de confirmação de pareamento
#define PIN_SOLO_ADC     A0  // Higrômetro Analógico de Solo

#define TIPO_DHT DHT11
DHT dht(PIN_DHT, TIPO_DHT);

// Configuração do Display LCD 16x2 com I2C (endereço 0x27 ou 0x3F)
LiquidCrystal_I2C lcd(0x27, 16, 2);

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
bool appConectado = false;

// Controle de mensagens temporárias no LCD
unsigned long tempoBloqueioLcd = 0;

// Intervalo de leitura e envio periódico (3000 ms = 3 segundos)
unsigned long ultimoEnvio = 0;
const unsigned long INTERVALO_ENVIO = 3000;

// Calibração do Higrômetro de Solo no Arduino Uno (ADC 10 bits: 0 a 1023)
const int SOLO_VALOR_SECO  = 850;
const int SOLO_VALOR_UMIDO = 350;

// Buffer de recepção de comandos do ESP-01
char bufferCmd[32];
uint8_t idxCmd = 0;

// =========================================================================================
// 3. FUNÇÕES DO DISPLAY LCD 16x2
// =========================================================================================

// Exibe mensagem temporária de destaque no LCD
void mostrarMensagemLcd(const __FlashStringHelper* l1, const __FlashStringHelper* l2, unsigned long duracaoMs) {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(l1);
  lcd.setCursor(0, 1);
  lcd.print(l2);
  tempoBloqueioLcd = millis() + duracaoMs;
}

// Atualiza o visor LCD com as leituras normais de sensores
void atualizarLcdSensores(float temp, float humAr, int humSolo, bool boiaOk) {
  // Se houver uma mensagem de destaque ativa (ex: pareamento ou botão), não sobrescreve
  if (millis() < tempoBloqueioLcd) return;

  // Linha 1: Temperatura e Umidade do Ar
  lcd.setCursor(0, 0);
  lcd.print(F("T:"));
  lcd.print(temp, 1);
  lcd.print(F("C U:"));
  lcd.print((int)humAr);
  lcd.print(F("%   "));

  // Linha 2: Umidade do Solo e Nível de Água
  lcd.setCursor(0, 1);
  lcd.print(F("Solo:"));
  lcd.print(humSolo);
  lcd.print(F("% "));
  lcd.print(boiaOk ? F("Ag:OK  ") : F("Ag:CRIT"));
}

// Confirmação visual na tela quando o usuário conecta no celular
void exibirConfirmacaoPareamento() {
  appConectado = true;

  // Pisca o LED onboard 3 vezes
  for (int i = 0; i < 3; i++) {
    digitalWrite(PIN_LED_STATUS, HIGH);
    delay(100);
    digitalWrite(PIN_LED_STATUS, LOW);
    delay(100);
  }
  digitalWrite(PIN_LED_STATUS, HIGH); // Deixa aceso indicando conectado

  // Mostra a confirmação bonita no visor LCD
  mostrarMensagemLcd(F("PAREADO COM APP!"), F("✓ CONECTADO OK"), 3500);

  Serial.println(F("\n[LCD] *** PAREAMENTO CONFIRMADO COM O APP WEB! ***"));
}

// =========================================================================================
// 4. LEITURA DOS SENSORES E ENVIO SERIAL AO ESP-01
// =========================================================================================
int lerUmidadeSolo() {
  int raw = analogRead(PIN_SOLO_ADC);
  int clamped = constrain(raw, SOLO_VALOR_UMIDO, SOLO_VALOR_SECO);
  int pct = map(clamped, SOLO_VALOR_SECO, SOLO_VALOR_UMIDO, 0, 100);
  return constrain(pct, 0, 100);
}

void enviarTelemetria() {
  float temp = dht.readTemperature();
  float humAr = dht.readHumidity();

  if (isnan(temp)) temp = 25.0;
  if (isnan(humAr)) humAr = 55.0;

  int humSolo = lerUmidadeSolo();
  bool boiaOk = (digitalRead(PIN_BOIA_AGUA) == LOW);

  // 1. Envia telemetria serial para o Adaptador ESP-01 publicar via MQTT
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

  // 2. Atualiza a tela LCD do Arduino
  atualizarLcdSensores(temp, humAr, humSolo, boiaOk);

  // Debug Serial USB
  Serial.print(F("[TELEMETRIA] T: "));
  Serial.print(temp, 1);
  Serial.print(F("C | Ar: "));
  Serial.print((int)humAr);
  Serial.print(F("% | Solo: "));
  Serial.print(humSolo);
  Serial.print(F("% | Boia: "));
  Serial.println(boiaOk ? F("OK") : F("CRIT"));
}

// =========================================================================================
// 5. PROCESSAMENTO DE COMANDOS RECEBIDOS DO ESP-01
// =========================================================================================
void processarComando(const char* cmd) {
  Serial.print(F("[COMANDO DO ESP-01]: "));
  Serial.println(cmd);

  // Comando de Pareamento recebido do App Web
  if (strstr(cmd, "parear") != NULL || strstr(cmd, "PAREAR") != NULL) {
    exibirConfirmacaoPareamento();
    enviarTelemetria();
    return;
  }

  bool mudouEstado = false;

  // Comando: Alternar Bomba de Água
  if (strstr(cmd, "bomba_toggle") != NULL || strstr(cmd, "BOMBA") != NULL) {
    estadoBomba = !estadoBomba;
    digitalWrite(PIN_RELE_BOMBA, estadoBomba ? RELE_LIGADO : RELE_DESLIGADO);
    mudouEstado = true;
    
    // Mostra no LCD a confirmação da ação do usuário
    mostrarMensagemLcd(F("BOMBA DE AGUA:"), estadoBomba ? F(">>> LIGADA <<<") : F(">>> DESLIGADA"), 2200);
    
    Serial.print(F("-> Bomba alterada: "));
    Serial.println(estadoBomba ? F("LIGADA") : F("DESLIGADA"));
  }
  // Comando: Alternar Ventoinha / Cooler
  else if (strstr(cmd, "ventoinha_toggle") != NULL || strstr(cmd, "VENT") != NULL) {
    estadoVentoinha = !estadoVentoinha;
    digitalWrite(PIN_RELE_VENT, estadoVentoinha ? RELE_LIGADO : RELE_DESLIGADO);
    mudouEstado = true;
    
    // Mostra no LCD a confirmação da ação do usuário
    mostrarMensagemLcd(F("VENTOINHA/COOLER:"), estadoVentoinha ? F(">>> LIGADA <<<") : F(">>> DESLIGADA"), 2200);
    
    Serial.print(F("-> Ventoinha alterada: "));
    Serial.println(estadoVentoinha ? F("LIGADA") : F("DESLIGADA"));
  }

  // Se mudou estado ou pediu status, atualiza telemetria imediatamente
  if (mudouEstado || strstr(cmd, "status") != NULL || strstr(cmd, "STATUS") != NULL) {
    enviarTelemetria();
  }
}

// =========================================================================================
// 6. SETUP E LOOP PRINCIPAL
// =========================================================================================
void setup() {
  Serial.begin(115200);
  delay(150);
  Serial.println(F("\n=============================================="));
  Serial.println(F(" ESTUFA INTELIGENTE - ARDUINO UNO + LCD 16x2"));
  Serial.println(F("=============================================="));

  // Inicializa o Display LCD 16x2 I2C
  lcd.init();
  lcd.backlight();
  lcd.clear();

  // Mensagem inicial de Inicialização e Código da Estufa
  lcd.setCursor(0, 0);
  lcd.print(F("ESTUFA ONLINE"));
  lcd.setCursor(0, 1);
  lcd.print(F("COD: "));
  lcd.print(F(CODIGO_ESTUFA));
  tempoBloqueioLcd = millis() + 4000; // Fica na tela por 4 segundos

  // Comunicação serial com o adaptador ESP-01
  espSerial.begin(9600);

  // Configuração dos Pinos dos Relés e LED
  pinMode(PIN_RELE_BOMBA, OUTPUT);
  pinMode(PIN_RELE_VENT, OUTPUT);
  pinMode(PIN_LED_STATUS, OUTPUT);
  digitalWrite(PIN_RELE_BOMBA, RELE_DESLIGADO);
  digitalWrite(PIN_RELE_VENT, RELE_DESLIGADO);
  digitalWrite(PIN_LED_STATUS, LOW);

  // Sensor de Boia
  pinMode(PIN_BOIA_AGUA, INPUT_PULLUP);

  // Sensor DHT11
  dht.begin();

  Serial.println(F("[ARDUINO] Sistema e LCD inicializados."));
  Serial.print(F("[ARDUINO] Codigo de Pareamento: "));
  Serial.println(F(CODIGO_ESTUFA));
}

void loop() {
  // 1. Escuta comandos seriais vindos do ESP-01 (enviados pelo App Web)
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

  // 2. Envio periódico da telemetria e atualização da tela LCD
  unsigned long agora = millis();
  if (agora - ultimoEnvio >= INTERVALO_ENVIO) {
    ultimoEnvio = agora;
    enviarTelemetria();
  }
}
