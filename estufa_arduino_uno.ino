/*
 * =========================================================================================
 * AGROLINK - FIRMWARE OFICIAL ARDUINO UNO
 * Comunicação: Bluetooth Clássico (HC-05) + Sensor Ultrassônico + Log Offline
 * Arquivo: estufa_arduino_uno.ino
 * =========================================================================================
 * 
 * Mapeamento Rigoroso de Pinos:
 *  - Pino 2 (RX): SoftwareSerial RX (Conectar ao TX do módulo Bluetooth HC-05)
 *  - Pino 3 (TX): SoftwareSerial TX (Conectar ao RX do módulo Bluetooth HC-05 via divisor)
 *  - Pino 8: Monitoramento do pino STATE do HC-05 (HIGH = Celular Conectado, LOW = Desconectado)
 *  - Pino 6: Sensor DHT11 (Temperatura e Umidade do Ar)
 *  - Pino A0: Sensor Higrômetro do Solo (Analógico)
 *  - Pino 4: Trigger do Sensor Ultrassônico HC-SR04 (Nível de Água)
 *  - Pino 5: Echo do Sensor Ultrassônico HC-SR04 (Nível de Água)
 *  - Pino 10: Relé da Bomba de Água (com trava de segurança contra queima a seco)
 *  - Pino 11: Buzzer Piezoelétrico (Alertas de nível crítico e confirmações sonoras)
 *  - Pino 13: Relé / Driver da Ventoinha (Controle de temperatura do ar)
 *  - Pinos A4 (SDA) e A5 (SCL): Display LCD 16x2 I2C no endereço 0x27
 * =========================================================================================
 */

#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <DHT.h>
#include <SoftwareSerial.h>
#include <avr/wdt.h>

// --- PINOS DE COMUNICAÇÃO BLUETOOTH (HC-05) ---
#define PIN_BT_RX 2          // RX do Arduino (conectar ao TX do HC-05)
#define PIN_BT_TX 3          // TX do Arduino (conectar ao RX do HC-05 via divisor de tensão)
#define PIN_BT_STATE 8       // Monitoramento do pino STATE do HC-05 (HIGH = Conectado)

// --- PINOS DOS SENSORES ---
#define DHTPIN 6             // Sensor DHT11 (Temperatura e Umidade do Ar)
#define DHTTYPE DHT11
const int PIN_SOLO = A0;     // Higrômetro de solo analógico

// Sensor Ultrassônico HC-SR04 (Nível do Reservatório de Água)
#define PIN_TRIG 4
#define PIN_ECHO 5

// --- PINOS DOS ATUADORES E ALERTAS ---
#define PIN_BOMBA 10         // Relé da Bomba de Água
#define PIN_BUZZER 11        // Buzzer para bipes e alertas
#define PIN_VENTOINHA 13     // Relé / Driver da Ventoinha (Cooler)

// Inicialização dos módulos de hardware
DHT dht(DHTPIN, DHTTYPE);
LiquidCrystal_I2C lcd(0x27, 16, 2);
SoftwareSerial btSerial(PIN_BT_RX, PIN_BT_TX);

// --- ÍCONES PERSONALIZADOS PARA O DISPLAY LCD (5x8 pixels) ---
byte iconeTermometro[8] = {
  B00100, B01010, B01010, B01010, B01110, B11111, B11111, B01110
};

byte iconeGota[8] = {
  B00100, B00100, B01110, B01110, B11111, B11111, B11111, B01110
};

byte iconeBluetooth[8] = {
  B00100, B00110, B10101, B01110, B01110, B10101, B00110, B00100
};

byte iconeAlerta[8] = {
  B00100, B01110, B01110, B01110, B11111, B11111, B00100, B00000
};

// --- CALIBRAÇÃO AGRONÔMICA E GEOMÉTRICA ---
const int LIMITE_SOLO_SECO_VAL = 400;     // Abaixo deste valor indica solo seco (<40%)
const int LIMITE_SOLO_MOLHADO_VAL = 800;  // Leitura em solo saturado (100%)
const float TEMP_IDEAL_MAX = 30.0;        // >30°C estresse térmico -> liga ventoinha
const float TEMP_IDEAL_MIN = 27.0;        // <=27°C resfriamento concluído -> desliga

// Calibração do reservatório com sensor ultrassônico
const int DIST_RES_CHEIO_CM = 4;          // 4 cm do sensor = Reservatório 100% cheio
const int DIST_RES_VAZIO_CM = 25;         // 25 cm do sensor = Reservatório vazio (0%)
const int NIVEL_AGUA_CRITICO_PCT = 15;    // <=15% de água é nível crítico: trava de segurança!

// --- ESTRUTURA COMPACTA PARA LOG OFFLINE (APENAS 6 BYTES POR REGISTRO) ---
struct RegistroOffline {
  uint16_t offsetSegundos; // Segundos decorridos antes da reconexão
  int8_t temp;             // Temperatura inteira (-128 a 127 °C)
  uint8_t umidAr;          // Umidade do Ar (0 a 100 %)
  uint8_t umidSolo;        // Umidade do Solo (0 a 100 %)
  uint8_t nivelAgua;       // Nível da Água (0 a 100 %)
  uint8_t bomba : 1;       // Estado da Bomba (0 ou 1)
  uint8_t ventoinha : 1;   // Estado da Ventoinha (0 ou 1)
};

const int MAX_REGISTROS_OFFLINE = 70;
RegistroOffline bufferOffline[MAX_REGISTROS_OFFLINE];
int totalRegistrosOffline = 0;
int indiceGravacaoOffline = 0;

// Temporizadores de gravação e telemetria
unsigned long tempoInicioOffline = 0;
unsigned long ultimoTempoLogOffline = 0;
const unsigned long intervaloLogOffline = 25000; // Grava a cada 25 segundos se desconectado

// --- VARIÁVEIS DE ESTADO DA ESTUFA ---
float temperatura = 25.0;
float umidadeAr = 65.0;
int umidadeSoloPorcento = 70;
int nivelAguaPorcento = 85;
long distanciaUltrassomCm = 7;
bool faltaAgua = false;

// Estado dos atuadores
bool bombaLigada = false;
bool ventoinhaLigada = false;

// Chaves de controle automático
bool autoBomba = true;
bool autoVentoinha = true;

// Estado de conexão Bluetooth (filtrado do pino 8)
bool bluetoothConectado = false;
bool bluetoothEstavaConectado = false;

// Temporizadores de ciclo geral
unsigned long ultimoTempoLeitura = 0;
const unsigned long intervaloLeitura = 600;      // Lê sensores a cada 600ms

unsigned long ultimoTempoTelemetria = 0;
const unsigned long intervaloTelemetria = 1500;   // Envia telemetria a cada 1.5s se conectado

unsigned long ultimoTempoLCD = 0;
const unsigned long tempoExibicaoTela = 3000;     // Alterna telas do LCD a cada 3s
int telaAtual = 1;

// Gerenciamento de mensagens não-bloqueantes no LCD
unsigned long tempoExpiracaoMensagemLCD = 0;
char linhaTemp0[17] = "";
char linhaTemp1[17] = "";
bool exibindoMensagemTemp = false;

unsigned long ultimoAlertaBuzzer = 0;

// Buffer de recepção serial
String bufferBT = "";
String bufferUSB = "";

// =========================================================================================
// DECLARAÇÃO ANTECIPADA DE FUNÇÕES
// =========================================================================================
void acionarBomba(bool ligar, const char* motivo = "");
void acionarVentoinha(bool ligar, const char* motivo = "");
void enviarConfirmacao(const char* atuador, int estado, const char* status);
void enviarTelemetria();
void descarregarLoteOfflineParaApp();
void verificarComandosSeriais();
void processarComando(String cmd);
void exibirMensagemRapida(const char* l0, const char* l1);

// =========================================================================================
// PADRÕES DE ALARME SONORO (BUZZER - PINO 11)
// =========================================================================================

void soarBipeCurto() {
  tone(PIN_BUZZER, 2000, 70);
}

void soarBipeConexaoSucesso() {
  tone(PIN_BUZZER, 2200, 100);
  delay(130);
  tone(PIN_BUZZER, 2700, 140);
}

void soarBipeDesconexao() {
  tone(PIN_BUZZER, 1200, 120);
  delay(140);
  tone(PIN_BUZZER, 800, 200);
}

void soarBipeAlertaAguaCritica() {
  tone(PIN_BUZZER, 950, 180);
}

// =========================================================================================
// LEITURA DO SENSOR ULTRASSÔNICO (NÍVEL DO RESERVATÓRIO)
// =========================================================================================

long medirDistanciaUltrassom() {
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);

  long duracao = pulseIn(PIN_ECHO, HIGH, 25000);
  if (duracao == 0) return -1;

  long distCm = duracao * 0.0343 / 2;
  return distCm;
}

void atualizarNivelAgua() {
  long d = medirDistanciaUltrassom();
  if (d > 0 && d < 100) {
    distanciaUltrassomCm = d;
    long pct = map(distanciaUltrassomCm, DIST_RES_VAZIO_CM, DIST_RES_CHEIO_CM, 0, 100);
    nivelAguaPorcento = constrain((int)pct, 0, 100);
  }

  // Trava de segurança: se o nível estiver crítico, ativa falta de água
  faltaAgua = (nivelAguaPorcento <= NIVEL_AGUA_CRITICO_PCT);

  if (faltaAgua && bombaLigada) {
    acionarBomba(false, "TravaSegurancaAguaAcabou");
  }
}

// =========================================================================================
// CONTROLE DOS ATUADORES COM TRAVA DE SEGURANÇA
// =========================================================================================

void acionarBomba(bool ligar, const char* motivo) {
  if (ligar && faltaAgua) {
    digitalWrite(PIN_BOMBA, LOW);
    bombaLigada = false;
    Serial.println(F("[SEGURANCA] Bloqueio: Bomba nao pode ligar sem agua!"));
    enviarConfirmacao("bomba", 0, "bloqueado_sem_agua");
    return;
  }

  digitalWrite(PIN_BOMBA, ligar ? HIGH : LOW);
  bombaLigada = ligar;
  enviarConfirmacao("bomba", bombaLigada ? 1 : 0, "ok");
}

void acionarVentoinha(bool ligar, const char* motivo) {
  digitalWrite(PIN_VENTOINHA, ligar ? HIGH : LOW);
  ventoinhaLigada = ligar;
  enviarConfirmacao("ventoinha", ventoinhaLigada ? 1 : 0, "ok");
}

// =========================================================================================
// COMUNICAÇÃO BLUETOOTH SERIAL (TELEMETRIA E CONFIRMAÇÕES)
// =========================================================================================

void enviarTelemetria() {
  String json = F("{\"temp\":");
  json += String(temperatura, 1);
  json += F(",\"umidade_ar\":");
  json += String((int)umidadeAr);
  json += F(",\"umidade_solo\":");
  json += String(umidadeSoloPorcento);
  json += F(",\"nivel_agua\":");
  json += String(nivelAguaPorcento);
  json += F(",\"status_agua\":\"");
  json += faltaAgua ? F("BAIXO") : F("OK");
  json += F("\",\"dist_cm\":");
  json += String(distanciaUltrassomCm);
  json += F(",\"bomba\":");
  json += String(bombaLigada ? 1 : 0);
  json += F(",\"ventoinha\":");
  json += String(ventoinhaLigada ? 1 : 0);
  json += F(",\"auto_bomba\":");
  json += String(autoBomba ? 1 : 0);
  json += F(",\"auto_ventoinha\":");
  json += String(autoVentoinha ? 1 : 0);
  json += F(",\"bt_online\":");
  json += String(bluetoothConectado ? 1 : 0);
  json += F("}\n");

  btSerial.print(json);
  Serial.print(F("[BT TELEMETRIA] "));
  Serial.print(json);
}

void enviarConfirmacao(const char* atuador, int estado, const char* status) {
  String ack = F("{\"ack\":\"");
  ack += atuador;
  ack += F("\",\"estado\":");
  ack += String(estado);
  ack += F(",\"status\":\"");
  ack += status;
  ack += F("\"}\n");

  btSerial.print(ack);
  Serial.print(F("[BT ACK] "));
  Serial.print(ack);
}

// =========================================================================================
// SISTEMA DE LOG OFFLINE E SINCRONIZAÇÃO EM LOTE
// =========================================================================================

void gravarRegistroOffline() {
  if (totalRegistrosOffline < MAX_REGISTROS_OFFLINE) {
    totalRegistrosOffline++;
  }

  RegistroOffline &reg = bufferOffline[indiceGravacaoOffline];
  
  unsigned long segundosPassados = (millis() - tempoInicioOffline) / 1000;
  reg.offsetSegundos = (uint16_t)constrain(segundosPassados, 0, 65535);
  reg.temp = (int8_t)round(temperatura);
  reg.umidAr = (uint8_t)constrain((int)umidadeAr, 0, 100);
  reg.umidSolo = (uint8_t)constrain(umidadeSoloPorcento, 0, 100);
  reg.nivelAgua = (uint8_t)constrain(nivelAguaPorcento, 0, 100);
  reg.bomba = bombaLigada ? 1 : 0;
  reg.ventoinha = ventoinhaLigada ? 1 : 0;

  indiceGravacaoOffline = (indiceGravacaoOffline + 1) % MAX_REGISTROS_OFFLINE;

  Serial.print(F("[LOG OFFLINE] Registro gravado na RAM. Total: "));
  Serial.println(totalRegistrosOffline);
}

void descarregarLoteOfflineParaApp() {
  if (totalRegistrosOffline == 0) {
    Serial.println(F("[SYNC] Nenhum dado offline acumulado."));
    enviarTelemetria();
    return;
  }

  Serial.print(F("[SYNC] Descarregando lote de "));
  Serial.print(totalRegistrosOffline);
  Serial.println(F(" leituras offline para o aplicativo..."));

  // 1. Notifica início da sincronização
  btSerial.print(F("{\"sync_start\":"));
  btSerial.print(totalRegistrosOffline);
  btSerial.println(F("}"));
  delay(25);

  int inicio = (indiceGravacaoOffline - totalRegistrosOffline + MAX_REGISTROS_OFFLINE) % MAX_REGISTROS_OFFLINE;
  unsigned long agora = millis();
  unsigned long duracaoOfflineSegundos = (agora - tempoInicioOffline) / 1000;

  // 2. Transmite cada registro offline linha a linha
  for (int i = 0; i < totalRegistrosOffline; i++) {
    wdt_reset();

    // Processa comandos seriais que possam chegar durante o streaming (evita travar botões!)
    verificarComandosSeriais();

    int idx = (inicio + i) % MAX_REGISTROS_OFFLINE;
    RegistroOffline &r = bufferOffline[idx];

    uint16_t segundosAtras = 0;
    if (duracaoOfflineSegundos > r.offsetSegundos) {
      segundosAtras = duracaoOfflineSegundos - r.offsetSegundos;
    }

    String item = F("{\"sync_item\":{\"t_offset\":");
    item += String(segundosAtras);
    item += F(",\"temp\":");
    item += String(r.temp);
    item += F(",\"umidade_ar\":");
    item += String(r.umidAr);
    item += F(",\"umidade_solo\":");
    item += String(r.umidSolo);
    item += F(",\"nivel_agua\":");
    item += String(r.nivelAgua);
    item += F(",\"bomba\":");
    item += String(r.bomba);
    item += F(",\"ventoinha\":");
    item += String(r.ventoinha);
    item += F("}}\n");

    btSerial.print(item);
    delay(15);
  }

  // 3. Notifica conclusão da sincronização
  btSerial.print(F("{\"sync_end\":true,\"count\":"));
  btSerial.print(totalRegistrosOffline);
  btSerial.println(F("}"));

  Serial.println(F("[SYNC] Sincronizacao offline concluida com sucesso!"));

  totalRegistrosOffline = 0;
  indiceGravacaoOffline = 0;

  soarBipeCurto();
}

// =========================================================================================
// PROCESSAMENTO ROBUSTO DE COMANDOS (JSON, TEXTO E CÓDIGOS CURTOS)
// =========================================================================================

void verificarComandosSeriais() {
  while (btSerial.available() > 0) {
    char c = btSerial.read();
    if (c == '\n' || c == '\r') {
      if (bufferBT.length() > 0) {
        processarComando(bufferBT);
        bufferBT = "";
      }
    } else if (bufferBT.length() < 96) {
      bufferBT += c;
    }
  }

  while (Serial.available() > 0) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (bufferUSB.length() > 0) {
        processarComando(bufferUSB);
        bufferUSB = "";
      }
    } else if (bufferUSB.length() < 96) {
      bufferUSB += c;
    }
  }
}

void processarComando(String cmd) {
  cmd.trim();
  if (cmd.length() == 0) return;

  Serial.print(F("[CMD RECEBIDO] "));
  Serial.println(cmd);

  soarBipeCurto();

  // --- 1. COMANDO BOMBA D'ÁGUA (PINO 10) ---
  // Reconhece: B1, B0, B, bomba_on, bomba_off, bomba_toggle, {"cmd":"bomba","val":1}, etc.
  if (cmd.equalsIgnoreCase("B1") || cmd.equalsIgnoreCase("bomba_on") || cmd.equalsIgnoreCase("bomba_1") ||
      (cmd.indexOf("\"cmd\":\"bomba\"") >= 0 && cmd.indexOf("\"val\":1") >= 0) ||
      (cmd.indexOf("bomba") >= 0 && (cmd.indexOf("1") >= 0 || cmd.indexOf("on") >= 0 || cmd.indexOf("ON") >= 0))) {
    if (!faltaAgua) {
      acionarBomba(true, "AppBT");
      exibirMensagemRapida("Comando BT:", "Bomba LIGADA!");
    } else {
      exibirMensagemRapida("BLOQUEADO!", "Res. Sem Agua!");
      enviarConfirmacao("bomba", 0, "bloqueado_sem_agua");
    }
  }
  else if (cmd.equalsIgnoreCase("B0") || cmd.equalsIgnoreCase("bomba_off") || cmd.equalsIgnoreCase("bomba_0") ||
           (cmd.indexOf("\"cmd\":\"bomba\"") >= 0 && cmd.indexOf("\"val\":0") >= 0) ||
           (cmd.indexOf("bomba") >= 0 && (cmd.indexOf("0") >= 0 || cmd.indexOf("off") >= 0 || cmd.indexOf("OFF") >= 0))) {
    acionarBomba(false, "AppBT");
    exibirMensagemRapida("Comando BT:", "Bomba DESLIGADA");
  }
  else if (cmd.equalsIgnoreCase("B") || cmd.equalsIgnoreCase("bomba_toggle") || (cmd.indexOf("bomba") >= 0 && cmd.indexOf("toggle") >= 0)) {
    if (!bombaLigada) {
      if (!faltaAgua) {
        acionarBomba(true, "AppBT");
        exibirMensagemRapida("Comando BT:", "Bomba LIGADA!");
      } else {
        exibirMensagemRapida("BLOQUEADO!", "Res. Sem Agua!");
        enviarConfirmacao("bomba", 0, "bloqueado_sem_agua");
      }
    } else {
      acionarBomba(false, "AppBT");
      exibirMensagemRapida("Comando BT:", "Bomba DESLIGADA");
    }
  }

  // --- 2. COMANDO VENTOINHA (PINO 13) ---
  // Reconhece: V1, V0, V, ventoinha_on, ventoinha_off, {"cmd":"ventoinha","val":1}, etc.
  else if (cmd.equalsIgnoreCase("V1") || cmd.equalsIgnoreCase("ventoinha_on") || cmd.equalsIgnoreCase("ventoinha_1") ||
           (cmd.indexOf("\"cmd\":\"ventoinha\"") >= 0 && cmd.indexOf("\"val\":1") >= 0) ||
           (cmd.indexOf("ventoinha") >= 0 && (cmd.indexOf("1") >= 0 || cmd.indexOf("on") >= 0 || cmd.indexOf("ON") >= 0))) {
    acionarVentoinha(true, "AppBT");
    exibirMensagemRapida("Comando BT:", "Ventoinha LIGADA");
  }
  else if (cmd.equalsIgnoreCase("V0") || cmd.equalsIgnoreCase("ventoinha_off") || cmd.equalsIgnoreCase("ventoinha_0") ||
           (cmd.indexOf("\"cmd\":\"ventoinha\"") >= 0 && cmd.indexOf("\"val\":0") >= 0) ||
           (cmd.indexOf("ventoinha") >= 0 && (cmd.indexOf("0") >= 0 || cmd.indexOf("off") >= 0 || cmd.indexOf("OFF") >= 0))) {
    acionarVentoinha(false, "AppBT");
    exibirMensagemRapida("Comando BT:", "Ventoinha DESL.");
  }
  else if (cmd.equalsIgnoreCase("V") || cmd.equalsIgnoreCase("ventoinha_toggle") || (cmd.indexOf("ventoinha") >= 0 && cmd.indexOf("toggle") >= 0)) {
    acionarVentoinha(!ventoinhaLigada, "AppBT");
    exibirMensagemRapida("Comando BT:", ventoinhaLigada ? "Ventoinha LIGADA" : "Ventoinha DESL.");
  }

  // --- 3. COMANDOS DE AUTOMÁTICO ---
  else if (cmd.equalsIgnoreCase("A1") || cmd.equalsIgnoreCase("auto_bomba_1") || cmd.equalsIgnoreCase("auto_bomba_on") ||
           (cmd.indexOf("auto_bomba") >= 0 && (cmd.indexOf("1") >= 0 || cmd.indexOf("true") >= 0))) {
    autoBomba = true;
    enviarConfirmacao("auto_bomba", 1, "ok");
    exibirMensagemRapida("Auto Bomba:", "ATIVADO");
  }
  else if (cmd.equalsIgnoreCase("A0") || cmd.equalsIgnoreCase("auto_bomba_0") || cmd.equalsIgnoreCase("auto_bomba_off") ||
           (cmd.indexOf("auto_bomba") >= 0 && (cmd.indexOf("0") >= 0 || cmd.indexOf("false") >= 0))) {
    autoBomba = false;
    enviarConfirmacao("auto_bomba", 0, "ok");
    exibirMensagemRapida("Auto Bomba:", "DESATIVADO");
  }
  else if (cmd.equalsIgnoreCase("C1") || cmd.equalsIgnoreCase("auto_ventoinha_1") || cmd.equalsIgnoreCase("auto_ventoinha_on") ||
           (cmd.indexOf("auto_ventoinha") >= 0 && (cmd.indexOf("1") >= 0 || cmd.indexOf("true") >= 0))) {
    autoVentoinha = true;
    enviarConfirmacao("auto_ventoinha", 1, "ok");
    exibirMensagemRapida("Auto Ventoinha:", "ATIVADO");
  }
  else if (cmd.equalsIgnoreCase("C0") || cmd.equalsIgnoreCase("auto_ventoinha_0") || cmd.equalsIgnoreCase("auto_ventoinha_off") ||
           (cmd.indexOf("auto_ventoinha") >= 0 && (cmd.indexOf("0") >= 0 || cmd.indexOf("false") >= 0))) {
    autoVentoinha = false;
    enviarConfirmacao("auto_ventoinha", 0, "ok");
    exibirMensagemRapida("Auto Ventoinha:", "DESATIVADO");
  }

  // --- 4. COMANDO SINCRONIZAÇÃO OFFLINE ---
  else if (cmd.equalsIgnoreCase("S") || cmd.equalsIgnoreCase("sync") || cmd.indexOf("sync") >= 0) {
    descarregarLoteOfflineParaApp();
  }

  // --- 5. COMANDO STATUS / TELEMETRIA ---
  else if (cmd.equalsIgnoreCase("T") || cmd.equalsIgnoreCase("status") || cmd.indexOf("status") >= 0) {
    enviarTelemetria();
  }
}

// =========================================================================================
// MENSAGEM NÃO-BLOQUEANTE NO LCD (SEM FREEZES)
// =========================================================================================

void exibirMensagemRapida(const char* l0, const char* l1) {
  strncpy(linhaTemp0, l0, 16);
  linhaTemp0[16] = '\0';
  strncpy(linhaTemp1, l1, 16);
  linhaTemp1[16] = '\0';

  exibindoMensagemTemp = true;
  tempoExpiracaoMensagemLCD = millis() + 1500; // 1.5s não-bloqueante

  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(linhaTemp0);
  lcd.setCursor(0, 1);
  lcd.print(linhaTemp1);
}

// =========================================================================================
// LEITURA ESTÁVEL DO PINO 8 (STATE DO HC-05 COM DEBOUNCE)
// =========================================================================================

bool lerEstadoBluetoothEstavel() {
  static bool estadoEstavel = false;
  static bool ultimoValorLido = false;
  static unsigned long tempoTransicao = 0;

  bool leituraAtual = (digitalRead(PIN_BT_STATE) == HIGH);

  if (leituraAtual != ultimoValorLido) {
    ultimoValorLido = leituraAtual;
    tempoTransicao = millis();
  }

  if ((millis() - tempoTransicao) > 80) { // 80ms de estabilidade de sinal
    estadoEstavel = leituraAtual;
  }

  return estadoEstavel;
}

// =========================================================================================
// SETUP
// =========================================================================================

void setup() {
  Serial.begin(9600);    // Monitor USB para depuração
  btSerial.begin(9600);  // Comunicação serial com módulo Bluetooth HC-05 (Pinos 2 RX e 3 TX)

  // Configuração dos pinos digitais
  pinMode(PIN_BT_STATE, INPUT);
  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
  pinMode(PIN_BOMBA, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_VENTOINHA, OUTPUT);

  // Inicializa saídas em nível seguro (desligadas)
  digitalWrite(PIN_TRIG, LOW);
  digitalWrite(PIN_BOMBA, LOW);
  digitalWrite(PIN_BUZZER, LOW);
  digitalWrite(PIN_VENTOINHA, LOW);

  // Inicializa sensores e display LCD I2C
  dht.begin();
  lcd.init();
  lcd.backlight();

  // Registra ícones customizados no LCD (0 a 3)
  lcd.createChar(0, iconeTermometro);
  lcd.createChar(1, iconeGota);
  lcd.createChar(2, iconeBluetooth);
  lcd.createChar(3, iconeAlerta);

  // Bipe de inicialização
  tone(PIN_BUZZER, 1800, 120);
  delay(140);
  tone(PIN_BUZZER, 2400, 150);

  // Apresentação inicial no LCD
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(F("AgroLink Estufa"));
  lcd.setCursor(0, 1);
  lcd.print(F("Bluetooth HC-05"));
  delay(1200);
  lcd.clear();

  Serial.println(F("========================================================="));
  Serial.println(F("   AGROLINK - SISTEMA INICIADO COM BLUETOOTH HC-05"));
  Serial.println(F("========================================================="));

  // Verifica estado inicial da conexão Bluetooth
  bluetoothConectado = (digitalRead(PIN_BT_STATE) == HIGH);
  bluetoothEstavaConectado = bluetoothConectado;
  if (!bluetoothConectado) {
    tempoInicioOffline = millis();
  }

  // Habilita Watchdog Timer de 8 segundos (proteção contra travamentos)
  wdt_enable(WDTO_8S);
}

// =========================================================================================
// LOOP PRINCIPAL
// =========================================================================================

void loop() {
  wdt_reset();

  unsigned long tempoAtual = millis();

  // ---------------------------------------------------------------------------------------
  // 1. MONITORAMENTO DO PINO 8 (STATE DO HC-05): HIGH = CONECTADO, LOW = LOG OFFLINE
  // ---------------------------------------------------------------------------------------
  bluetoothConectado = lerEstadoBluetoothEstavel();

  // Transição: DESCONECTADO -> CONECTADO
  if (bluetoothConectado && !bluetoothEstavaConectado) {
    bluetoothEstavaConectado = true;
    Serial.println(F("[BLUETOOTH] Celular CONECTADO em tempo real!"));
    soarBipeConexaoSucesso();

    exibirMensagemRapida("AgroLink Estufa", "BT Conectado!");

    // Descarrega o lote histórico acumulado durante a desconexão
    if (totalRegistrosOffline > 0) {
      descarregarLoteOfflineParaApp();
    } else {
      enviarTelemetria();
    }
  }
  // Transição: CONECTADO -> DESCONECTADO
  else if (!bluetoothConectado && bluetoothEstavaConectado) {
    bluetoothEstavaConectado = false;
    tempoInicioOffline = tempoAtual;
    ultimoTempoLogOffline = tempoAtual;
    Serial.println(F("[BLUETOOTH] Celular DESCONECTADO. Ativando Log Offline na RAM..."));
    soarBipeDesconexao();
  }

  // ---------------------------------------------------------------------------------------
  // 2. RECEBIMENTO E PROCESSAMENTO CONTÍNUO DE COMANDOS BLUETOOTH / USB
  // ---------------------------------------------------------------------------------------
  verificarComandosSeriais();

  // ---------------------------------------------------------------------------------------
  // 3. LEITURA DOS SENSORES E CONTROLE AUTOMÁTICO INTELIGENTE
  // ---------------------------------------------------------------------------------------
  if (tempoAtual - ultimoTempoLeitura >= intervaloLeitura) {
    ultimoTempoLeitura = tempoAtual;

    // A. Leitura DHT11 (Pino 6)
    float t = dht.readTemperature();
    float h = dht.readHumidity();
    if (!isnan(t)) temperatura = t;
    if (!isnan(h)) umidadeAr = h;

    // B. Leitura Higrômetro do Solo (Pino A0)
    int soloBruto = analogRead(PIN_SOLO);
    umidadeSoloPorcento = map(soloBruto, LIMITE_SOLO_SECO_VAL, LIMITE_SOLO_MOLHADO_VAL, 0, 100);
    umidadeSoloPorcento = constrain(umidadeSoloPorcento, 0, 100);

    // C. Leitura do Sensor Ultrassônico (Pinos 4 e 5) - Nível de Água
    atualizarNivelAgua();

    // D. Alerta sonoro periódico caso o reservatório esteja vazio
    if (faltaAgua) {
      if (tempoAtual - ultimoAlertaBuzzer >= 4500) {
        ultimoAlertaBuzzer = tempoAtual;
        soarBipeAlertaAguaCritica();
      }
    }

    // E. Automação Inteligente da Bomba de Água
    if (autoBomba && !faltaAgua) {
      if (umidadeSoloPorcento < 40 && !bombaLigada) {
        acionarBomba(true, "AutoSoloSeco");
      }
      else if (umidadeSoloPorcento >= 75 && bombaLigada) {
        acionarBomba(false, "AutoSoloIdeal");
      }
    }

    // F. Automação Inteligente da Ventoinha
    if (autoVentoinha) {
      if (temperatura > TEMP_IDEAL_MAX && !ventoinhaLigada) {
        acionarVentoinha(true, "AutoTempAlta");
      }
      else if (temperatura <= TEMP_IDEAL_MIN && ventoinhaLigada) {
        acionarVentoinha(false, "AutoTempNormal");
      }
    }
  }

  // ---------------------------------------------------------------------------------------
  // 4. GRAVAÇÃO DE LOG OFFLINE QUANDO O CELULAR ESTIVER DESCONECTADO (PINO 8 LOW)
  // ---------------------------------------------------------------------------------------
  if (!bluetoothConectado) {
    if (tempoAtual - ultimoTempoLogOffline >= intervaloLogOffline) {
      ultimoTempoLogOffline = tempoAtual;
      gravarRegistroOffline();
    }
  }

  // ---------------------------------------------------------------------------------------
  // 5. ENVIO PERIÓDICO DE TELEMETRIA EM TEMPO REAL (QUANDO CONECTADO)
  // ---------------------------------------------------------------------------------------
  if (bluetoothConectado) {
    if (tempoAtual - ultimoTempoTelemetria >= intervaloTelemetria) {
      ultimoTempoTelemetria = tempoAtual;
      enviarTelemetria();
    }
  }

  // ---------------------------------------------------------------------------------------
  // 6. ATUALIZAÇÃO DO DISPLAY LCD 16x2
  // ---------------------------------------------------------------------------------------
  if (exibindoMensagemTemp) {
    if (tempoAtual >= tempoExpiracaoMensagemLCD) {
      exibindoMensagemTemp = false;
      lcd.clear();
      ultimoTempoLCD = tempoAtual;
    }
  } else {
    if (tempoAtual - ultimoTempoLCD >= tempoExibicaoTela) {
      ultimoTempoLCD = tempoAtual;
      telaAtual = (telaAtual == 1) ? 2 : 1;
      lcd.clear();
    }

    // --- TELA 1: Ambiente & Clima (Temperatura e Umidade do Ar) ---
    if (telaAtual == 1) {
      lcd.setCursor(0, 0);
      lcd.print(F("Clima Estufa "));
      lcd.setCursor(14, 0);
      if (bluetoothConectado) {
        lcd.write(byte(2)); // Ícone Bluetooth
        lcd.print(F(" "));
      } else {
        lcd.print(F("--"));
      }

      lcd.setCursor(0, 1);
      lcd.write(byte(0)); // Termômetro
      lcd.print((int)round(temperatura));
      lcd.print(F("C "));

      lcd.print(F("Ar:"));
      lcd.print((int)round(umidadeAr));
      lcd.print(F("% "));

      lcd.setCursor(12, 1);
      lcd.print(ventoinhaLigada ? F("V:ON") : F("V:OF"));
    }
    // --- TELA 2: Solo & Reservatório Ultrassônico de Água ---
    else {
      lcd.setCursor(0, 0);
      lcd.print(F("Solo:"));
      lcd.write(byte(1)); // Gota
      lcd.print(umidadeSoloPorcento);
      lcd.print(F("% "));
      lcd.print(bombaLigada ? F("B:ON") : F("B:OF"));

      lcd.setCursor(0, 1);
      if (faltaAgua) {
        lcd.write(byte(3)); // Alerta
        lcd.print(F(" RES. CRITICO! "));
      } else {
        lcd.print(F("Agua:"));
        lcd.print(nivelAguaPorcento);
        lcd.print(F("% [OK]"));
      }
    }
  }
}
