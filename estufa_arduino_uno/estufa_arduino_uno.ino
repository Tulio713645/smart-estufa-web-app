/*
 * =========================================================================================
 * AGROLINK - FIRMWARE ARDUINO UNO (OTIMIZADO MÁXIMO RAM)
 * Comunicação: Bluetooth Clássico (HC-05) + Sensor Ultrassônico + Log Offline
 * =========================================================================================
 * PINOS:
 *  2: BT RX (SoftwareSerial)  <- TX HC-05
 *  3: BT TX (SoftwareSerial)  -> RX HC-05 (divisor tensão)
 *  4: TRIG  Ultrassônico HC-SR04
 *  5: ECHO  Ultrassônico HC-SR04
 *  6: DHT11
 *  7: BOTÃO físico (INPUT_PULLUP, HIGH=solto, LOW=pressionado)
 *  8: STATE HC-05 (INPUT_PULLUP: HIGH=conectado, LOW=desconectado)
 * 10: Relé Bomba (Active LOW: LOW=LIGA, HIGH=DESLIGA)
 * 11: Buzzer
 * 13: Relé Ventoinha (NORMAL: HIGH=LIGA, LOW=DESLIGA)
 * A0: Solo (analógico) - sensor capacitivo: MENOR valor = MOLHADO
 * A4: SDA LCD I2C 0x27
 * A5: SCL LCD I2C 0x27
 * =========================================================================================
 * PROTOCOLO (9600 baud, \n terminated):
 *  B1/B0, V1/V0, A1/A0, C1/C0, S, T, L  +  formas textuais + JSON
 *  L / LCD / LCD_TOGGLE -> alterna tela do LCD 16x2
 *  Telemetria: {"temp":25.4,"umidade_ar":65,"umidade_solo":70,"nivel_agua":80,
 *               "status_agua":"OK","falta_agua":0,"dist_cm":7,"bomba":0,"ventoinha":0,
 *               "auto_bomba":1,"auto_ventoinha":1,"bt_online":1}
 *  Offline: {"sync_start":N} + Nx{"sync_item":{...}} + {"sync_end":true,"count":N}
 * =========================================================================================
 * RAM: Zero alocação dinâmica, sem String, sem delay(), WDT a cada loop
 * =========================================================================================
 */

#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <DHT.h>
#include <SoftwareSerial.h>
#include <avr/wdt.h>
#include <string.h>

// ---- PINOS ----
#define PIN_BT_RX        2
#define PIN_BT_TX        3
#define PIN_BT_STATE     8       // HC-05 STATE: INPUT (sem pullup) - HIGH=conectado, LOW=desconectado
#define PIN_BTN          7       // Botão físico (INPUT_PULLUP)
#define DHTPIN           6
#define DHTTYPE          DHT11
#define PIN_SOLO         A0
#define PIN_TRIG         4
#define PIN_ECHO         5
#define PIN_BOMBA        10
#define PIN_BUZZER       11
#define PIN_VENTOINHA    13

// ---- CONSTANTES (PROGMEM via F()) ----
// Sensor capacitivo de solo: valor BAIXO = molhado, valor ALTO = seco
const int SOLO_MOLHADO_VAL   = 300;   // leitura em solo saturado (100%)
const int SOLO_SECO_VAL      = 750;   // leitura em solo seco (0%)
const float TEMP_IDEAL_MAX   = 30.0;
const float TEMP_IDEAL_MIN   = 27.0;
const int DIST_RES_CHEIO_CM  = 4;
const int DIST_RES_VAZIO_CM  = 25;
const int NIVEL_AGUA_CRITICO_PCT = 15;

// ---- OFFLINE LOG: 6 bytes/registro ----
struct RegistroOffline {
  uint8_t cicloHi, cicloLo;
  int8_t  temp;
  uint8_t umidAr;     // bit7 = bomba
  uint8_t umidSolo;   // bit7 = ventoinha
  uint8_t nivelAgua;  // bit7 = faltaAgua
};

const int MAX_REG_OFFLINE = 20;          // 20 * 25s = ~8 min (economiza RAM)
RegistroOffline bufOff[MAX_REG_OFFLINE];
uint8_t nOff = 0, wOff = 0;

unsigned long tLogOff = 0;
const unsigned long INT_LOG_OFF = 25000UL;

// ---- ESTADO ----
float temp = 25.0, humAr = 65.0;
int humSolo = 70, nivAgua = 85;
long distCM = 7;
bool semAgua = false;
bool bombaOn = false, ventOn = false;
bool autoBomba = true, autoVent = true;
bool btOn = false, btWasOn = false;
bool syncing = false;
unsigned long lastBtRx = 0;          // último byte recebido do BT
bool btDataReceived = false;         // flag: já recebeu algum dado?
const unsigned long BT_TIMEOUT = 5000; // 5s sem dados = desconectado

// BT STATE debounce state (inicializado no setup)
bool stStable = false;
bool stLast = false;
unsigned long stTrans = 0;

// ---- BOTÃO FÍSICO Pino 7 (INPUT_PULLUP) ----
bool btnLast = true;       // HIGH = solto (pull-up)
unsigned long btnTrans = 0;
bool btnStable = true;

// ---- TEMPOS ----
unsigned long tRead = 0, tDHT = 0, tUltra = 0, tTelem = 0;
const unsigned long I_READ = 600, I_DHT = 1500, I_ULTRA = 2000, I_TELEM = 1500;
int tela = 1;

// ---- BOTÃO FÍSICO: DETECÇÃO CURTO/LONGO ----
unsigned long btnPressStart = 0;
bool btnWasPressed = false;
const unsigned long LONG_PRESS_MS = 2000;  // 2 segundos para pressão longa

// ---- IRRIGAÇÃO DE EMERGÊNCIA (botão longo) ----
unsigned long emergencyPumpEnd = 0;  // 0 = inativo

// ---- LCD MSG TEMP ----
unsigned long tMsgExp = 0;
char msg0[17], msg1[17];
bool showingMsg = false;

// ---- BUZZER NÃO-BLOQUEANTE ----
enum { BZ_IDLE, BZ_1, BZ_2 } bzSt = BZ_IDLE;
unsigned long bzNext = 0;

// ---- ULTRASSÔNICO NÃO-BLOQUEANTE ----
enum { US_IDLE, US_TRIG, US_ECHO } usSt = US_IDLE;
unsigned long usT0 = 0;
long usDur = 0;

// ---- SYNC OFFLINE INCREMENTAL ----
enum { SY_IDLE, SY_START, SY_ITEMS, SY_END } sySt = SY_IDLE;
int syIdx = 0, syTot = 0, syStart = 0;
uint16_t syCiclo = 0;
unsigned long syNext = 0;

// ---- SERIAL BUFFERS ----
#define CMD_BUF 32
char btBuf[CMD_BUF]; uint8_t btLen = 0;
char usbBuf[CMD_BUF]; uint8_t usbLen = 0;

// ---- HARDWARE ----
DHT dht(DHTPIN, DHTTYPE);
LiquidCrystal_I2C lcd(0x27, 16, 2);
SoftwareSerial btSer(PIN_BT_RX, PIN_BT_TX);

// =========================================================================================
// SETUP
// =========================================================================================
void setup() {
  Serial.begin(9600);
  btSer.begin(9600);

  // HC-05 STATE pin 8: INPUT (sem pullup)
  // HIGH = conectado (módulo puxa HIGH), LOW = desconectado (flutua/baixa)
  pinMode(PIN_BT_STATE, INPUT);
  pinMode(PIN_BTN, INPUT_PULLUP);     // Botão físico pino 7: HIGH=solto, LOW=pressionado
  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
  pinMode(PIN_BOMBA, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_VENTOINHA, OUTPUT);

  digitalWrite(PIN_TRIG, LOW);
  digitalWrite(PIN_BOMBA, HIGH);      // Bomba: Relé active LOW (HIGH = DESLIGADO)
  digitalWrite(PIN_BUZZER, LOW);
  digitalWrite(PIN_VENTOINHA, LOW);   // Ventoinha: NORMAL (LOW = DESLIGADO)

  dht.begin();
  lcd.init(); lcd.backlight();

  // Bipe init não-bloqueante
  tone(PIN_BUZZER, 1800, 120); bzSt = BZ_1; bzNext = millis() + 140;

  lcd.clear();
  lcd.print(F("AgroLink Estufa"));
  lcd.setCursor(0,1); lcd.print(F("Bluetooth HC-05"));
  tMsgExp = millis() + 1200; showingMsg = true;

  // HC-05 STATE pin 8: HIGH=conectado, LOW=desconectado (INPUT sem pullup)
  btOn = (digitalRead(PIN_BT_STATE) == HIGH);
  btWasOn = btOn;
  if (!btOn) { tLogOff = millis(); }

  wdt_enable(WDTO_8S);
}

// =========================================================================================
// LOOP - wdt_reset() SEMPRE PRIMEIRO
// =========================================================================================
void loop() {
  wdt_reset();
  unsigned long now = millis();

  // ---- 1. BT CONEXÃO: STATE pin 8 (primário, confiável no seu módulo) ----
  // HC-05 STATE pin 8 com INPUT: HIGH=conectado, LOW=desconectado
  // Usa variáveis globais (inicializadas no setup com leitura real)
  bool stNow = (digitalRead(PIN_BT_STATE) == HIGH);
  if (stNow != stLast) { stLast = stNow; stTrans = now; }
  if (now - stTrans > 80) stStable = stNow;  // debounce 80ms

  // CONFIA 100% NO STATE PIN (seu módulo funciona corretamente)
  // Dados recentes só servem para log/debug, NÃO derrubam conexão
  bool btOnNew = stStable;

  // Detecta mudança de estado BT -> atualiza tela imediatamente
  if (btOnNew != btOn) {
    btOn = btOnNew;
    if (btOn && !btWasOn) {
      btWasOn = true;
      Serial.println(F("[BT] Conectado"));
      tone(PIN_BUZZER, 2200, 100); bzSt = BZ_1; bzNext = now + 130;
      showMsg("AgroLink Estufa", "BT Conectado!");
      if (nOff > 0) startSync(); else sendTelem();
    }
    else if (!btOn && btWasOn) {
      btWasOn = false;
      tLogOff = now;
      Serial.println(F("[BT] Desconectado - Log Offline"));
      tone(PIN_BUZZER, 1200, 120); bzSt = BZ_1; bzNext = now + 140;
    }
    drawCurrentScreen();  // FORÇA atualização da tela
  }

  // ---- 1b. BOTÃO FÍSICO PINO 7 - Detecção Curto vs Longo (debounce 50ms) ----
  // INPUT_PULLUP: HIGH = solto, LOW = pressionado
  bool btnNow = (digitalRead(PIN_BTN) == LOW);

  // Debounce simples
  if (btnNow != btnLast) { btnLast = btnNow; btnTrans = now; }

  // Botão ESTÁVEL pressionado (LOW)
  if (btnNow && btnStable && (now - btnTrans > 50)) {
    // Marca início da pressão se primeira vez
    if (!btnWasPressed) {
      btnPressStart = now;
      btnWasPressed = true;
    }
  }
  // Botão ESTÁVEL solto (HIGH) - detecta fim da pressão
  else if (!btnNow && btnWasPressed && (now - btnTrans > 50)) {
    unsigned long pressDuration = now - btnPressStart;
    btnWasPressed = false;

    if (pressDuration >= LONG_PRESS_MS) {
      // ===== PRESSIONAMENTO LONGO (>= 2s) =====
      // Silencia buzzer/alarme OU inicia irrigação manual de emergência
      if (semAgua) {
        // Se sem água, só silencia o buzzer
        noTone(PIN_BUZZER);
        bzSt = BZ_IDLE;
        showMsg("Buzzer:", "Silenciado!");
      } else {
        // Irrigação manual de emergência (liga bomba por 10s)
        setBomba(true);
        emergencyPumpEnd = now + 10000;
        showMsg("IRRIGACAO", "Emergencia 10s!");
      }
    } else {
      // ===== TOQUE CURTO (< 2s) =====
      // Alterna tela do LCD
      tela = (tela == 1) ? 2 : 1;
      showMsg("LCD Tela:", tela==1?"Temp/Umidade":"Solo/Reserv.");
      drawCurrentScreen();
    }
  }
  // Atualiza btnStable para debounce
  if (now - btnTrans > 50) {
    btnStable = btnNow;
  }

  // ---- 2. COMANDOS SERIAIS ----
  readSerial();

  // ---- 3. PERIFÉRICOS NÃO-BLOQUEANTES ----
  updateBuzzer();
  updateUltra(now);
  processSync(now);

  // ---- 4. SENSORES ----
  if (now - tRead >= I_READ) {
    tRead = now;
    int raw = analogRead(PIN_SOLO);
    // Sensor capacitivo: MENOR valor = MOLHADO (invertido)
    humSolo = map(raw, SOLO_MOLHADO_VAL, SOLO_SECO_VAL, 100, 0);
    if (humSolo < 0) humSolo = 0; else if (humSolo > 100) humSolo = 100;
  }

  if (now - tDHT >= I_DHT) {
    tDHT = now;
    float t = dht.readTemperature();
    float h = dht.readHumidity();
    if (!isnan(t)) temp = t;
    if (!isnan(h)) humAr = h;
  }

  if (now - tUltra >= I_ULTRA) {
    tUltra = now;
    usSt = US_TRIG; usT0 = micros(); digitalWrite(PIN_TRIG, HIGH);
  }

  // Auto bomba
  if (autoBomba && !semAgua) {
    if (humSolo < 40 && !bombaOn) setBomba(true);
    else if (humSolo >= 75 && bombaOn) setBomba(false);
  }
  // Auto ventoinha
  if (autoVent) {
    if (temp > TEMP_IDEAL_MAX && !ventOn) setVent(true);
    else if (temp <= TEMP_IDEAL_MIN && ventOn) setVent(false);
  }

  // ---- IRRIGAÇÃO DE EMERGÊNCIA: desliga bomba após 10s ----
  if (emergencyPumpEnd && now >= emergencyPumpEnd) {
    setBomba(false);
    emergencyPumpEnd = 0;
    showMsg("Irrigacao:", "Ciclo finalizado");
  }

  // Log offline
  if (!btOn && now - tLogOff >= INT_LOG_OFF) {
    tLogOff = now;
    uint16_t c = (uint16_t)(now / INT_LOG_OFF);
    RegistroOffline &r = bufOff[wOff];
    r.cicloHi = c >> 8; r.cicloLo = c & 0xFF;
    r.temp = (int8_t)constrain((int)temp, -128, 127);
    r.umidAr = (uint8_t)constrain((int)humAr, 0, 100) | (bombaOn ? 0x80 : 0);
    r.umidSolo = (uint8_t)constrain(humSolo, 0, 100) | (ventOn ? 0x80 : 0);
    r.nivelAgua = (uint8_t)constrain(nivAgua, 0, 100) | (semAgua ? 0x80 : 0);
    wOff = (wOff + 1) % MAX_REG_OFFLINE;
    if (nOff < MAX_REG_OFFLINE) nOff++;
  }

  // Telemetria tempo real
  if (btOn && now - tTelem >= I_TELEM) {
    tTelem = now; sendTelem();
  }

  // LCD msg expirou -> redesenha tela atual
  if (showingMsg && now >= tMsgExp) {
    showingMsg = false;
    drawCurrentScreen();
  }
}

// =========================================================================================
// BUZZER
// =========================================================================================
void updateBuzzer() {
  unsigned long n = millis();
  if (bzSt != BZ_IDLE && n >= bzNext) { noTone(PIN_BUZZER); bzSt = BZ_IDLE; }
}

// =========================================================================================
// ULTRASSÔNICO STATE MACHINE
// =========================================================================================
void updateUltra(unsigned long now) {
  unsigned long um = micros();
  switch (usSt) {
    case US_TRIG:
      if (um - usT0 >= 10) { digitalWrite(PIN_TRIG, LOW); usSt = US_ECHO; usT0 = um; }
      break;
    case US_ECHO:
      if (digitalRead(PIN_ECHO) == HIGH) { usT0 = um; usSt = US_IDLE; }
      else if (um - usT0 > 25000) { distCM = -1; usSt = US_IDLE; }
      break;
    case US_IDLE:
      if (digitalRead(PIN_ECHO) == LOW && usT0 > 0) {
        usDur = um - usT0;
        if (usDur > 0 && usDur < 25000) {
          long d = usDur * 0.0343 / 2;
          if (d > 0 && d < 100) { distCM = d; long p = map(d, DIST_RES_VAZIO_CM, DIST_RES_CHEIO_CM, 0, 100); nivAgua = constrain((int)p, 0, 100); }
        }
        usT0 = 0;
        semAgua = (nivAgua <= NIVEL_AGUA_CRITICO_PCT);
        if (semAgua && bombaOn) setBomba(false);
        static unsigned long lastBeep = 0;
        if (semAgua && now - lastBeep >= 4500) { lastBeep = now; tone(PIN_BUZZER, 950, 180); }
      }
      break;
  }
}

// =========================================================================================
// SYNC OFFLINE INCREMENTAL (5ms/item, wdt_reset a cada item)
// =========================================================================================
void startSync() {
  if (syncing || nOff == 0) return;
  syncing = true; sySt = SY_START; syTot = nOff; syIdx = 0;
  syStart = (wOff - nOff + MAX_REG_OFFLINE) % MAX_REG_OFFLINE;
  syCiclo = (uint16_t)(millis() / INT_LOG_OFF);
  syNext = 0;
  Serial.print(F("[SYNC] ")); Serial.print(syTot); Serial.println(F(" itens"));
}

void processSync(unsigned long now) {
  if (!syncing) return;
  if (now < syNext) return;
  wdt_reset(); readSerial();

  switch (sySt) {
    case SY_START:
      btSer.print(F("{\"sync_start\":")); btSer.print(syTot); btSer.print(F("}\n"));
      sySt = SY_ITEMS; syNext = now + 5; break;
    case SY_ITEMS:
      if (syIdx < syTot) {
        int idx = (syStart + syIdx) % MAX_REG_OFFLINE;
        RegistroOffline &r = bufOff[idx];
        uint16_t cReg = ((uint16_t)r.cicloHi << 8) | r.cicloLo;
        uint16_t diff = (uint16_t)(syCiclo - cReg);
        uint32_t seg = (uint32_t)diff * (INT_LOG_OFF / 1000);
        if (seg > 65535) seg = 65535;

        btSer.print(F("{\"sync_item\":{\"t_offset\":")); btSer.print((unsigned long)seg);
        btSer.print(F(",\"temp\":")); btSer.print((int)r.temp);
        btSer.print(F(",\"umidade_ar\":")); btSer.print((int)(r.umidAr & 0x7F));
        btSer.print(F(",\"umidade_solo\":")); btSer.print((int)(r.umidSolo & 0x7F));
        btSer.print(F(",\"nivel_agua\":")); btSer.print((int)(r.nivelAgua & 0x7F));
        btSer.print(F(",\"bomba\":")); btSer.print((r.umidAr & 0x80) ? 1 : 0);
        btSer.print(F(",\"ventoinha\":")); btSer.print((r.umidSolo & 0x80) ? 1 : 0);
        btSer.print(F(",\"falta_agua\":")); btSer.print((r.nivelAgua & 0x80) ? 1 : 0);
        btSer.print(F("}}\n"));
        syIdx++; syNext = now + 5;
      } else { sySt = SY_END; syNext = now + 5; }
      break;
    case SY_END:
      btSer.print(F("{\"sync_end\":true,\"count\":")); btSer.print(syTot); btSer.print(F("}\n"));
      Serial.println(F("[SYNC] Fim"));
      nOff = 0; wOff = 0; syncing = false; sySt = SY_IDLE;
      tone(PIN_BUZZER, 2000, 70);
      break;
  }
}

// =========================================================================================
// TELEMETRIA / CONFIRMAÇÃO (print direto, sem String)
// =========================================================================================
void sendTelem() {
  btSer.print(F("{\"temp\":")); btSer.print(temp, 1);
  btSer.print(F(",\"umidade_ar\":")); btSer.print((int)humAr);
  btSer.print(F(",\"umidade_solo\":")); btSer.print(humSolo);
  btSer.print(F(",\"nivel_agua\":")); btSer.print(nivAgua);
  btSer.print(F(",\"status_agua\":\"")); btSer.print(semAgua ? F("BAIXO") : F("OK"));
  btSer.print(F("\",\"falta_agua\":")); btSer.print(semAgua ? 1 : 0);
  btSer.print(F(",\"dist_cm\":")); btSer.print((int)distCM);
  btSer.print(F(",\"bomba\":")); btSer.print(bombaOn ? 1 : 0);
  btSer.print(F(",\"ventoinha\":")); btSer.print(ventOn ? 1 : 0);
  btSer.print(F(",\"auto_bomba\":")); btSer.print(autoBomba ? 1 : 0);
  btSer.print(F(",\"auto_ventoinha\":")); btSer.print(autoVent ? 1 : 0);
  btSer.print(F(",\"bt_online\":")); btSer.print(btOn ? 1 : 0);
  btSer.print(F("}\n"));
}

void sendAck(const char* a, int v, const char* s) {
  btSer.print(F("{\"ack\":\"")); btSer.print(a);
  btSer.print(F("\",\"estado\":")); btSer.print(v);
  btSer.print(F(",\"status\":\"")); btSer.print(s); btSer.print(F("\"}\n"));
}

// =========================================================================================
// ATUADORES
// =========================================================================================
void setBomba(bool on) {
  if (on && semAgua) { digitalWrite(PIN_BOMBA, HIGH); bombaOn = false; sendAck("bomba", 0, "bloqueado_sem_agua"); return; }
  digitalWrite(PIN_BOMBA, on ? LOW : HIGH); bombaOn = on; sendAck("bomba", bombaOn ? 1 : 0, "ok");
}
void setVent(bool on) { digitalWrite(PIN_VENTOINHA, on ? HIGH : LOW); ventOn = on; sendAck("ventoinha", ventOn ? 1 : 0, "ok"); }

// =========================================================================================
// SERIAL READ
// =========================================================================================
void readSerial() {
  while (btSer.available()) { char c = btSer.read(); lastBtRx = millis(); btDataReceived = true; if (c=='\n'||c=='\r') procLine(btBuf, btLen); else if (btLen < CMD_BUF-1) btBuf[btLen++] = c; else btLen = 0; }
  while (Serial.available()) { char c = Serial.read(); if (c=='\n'||c=='\r') procLine(usbBuf, usbLen); else if (usbLen < CMD_BUF-1) usbBuf[usbLen++] = c; else usbLen = 0; }
}
void procLine(char* b, uint8_t& l) { if (l) { b[l] = 0; parseCmd(b); l = 0; } }

// =========================================================================================
// PARSER (sem alocação, word-boundary)
// =========================================================================================
inline bool isSep(char c) { return !((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='_'); }
inline char toLow(char c) { return (c>='A'&&c<='Z') ? c+32 : c; }
bool eqIC(const char* a, const char* b) { while(*a&&*b){ if(toLow(*a)!=toLow(*b)) return 0; a++; b++; } return *a==*b; }
bool hasTok(const char* txt, const char* tok) {
  size_t lt = strlen(tok); const char* p = txt;
  while(*p){ if(isSep(*p)){ p++; continue; } const char* s=p; while(*p&&!isSep(*p)) p++; if((size_t)(p-s)==lt){ bool ok=1; for(size_t i=0;i<lt;i++) if(toLow(s[i])!=toLow(tok[i])){ ok=0; break; } if(ok) return 1; } } return 0; }
int getVal(const char* c) {
  if(hasTok(c,"toggle")||hasTok(c,"alternar")||hasTok(c,"inverter")) return 2;
  if(hasTok(c,"on")||hasTok(c,"ligar")||hasTok(c,"ativar")||hasTok(c,"true")||hasTok(c,"1")||hasTok(c,"enable")) return 1;
  if(hasTok(c,"off")||hasTok(c,"desligar")||hasTok(c,"desativar")||hasTok(c,"false")||hasTok(c,"0")||hasTok(c,"disable")) return 0;
  return -1;
}

void parseCmd(char* c) {
  while(*c==' '||*c=='\t') c++;
  size_t n = strlen(c);
  while(n && (c[n-1]==' '||c[n-1]=='\t'||c[n-1]=='\r'||c[n-1]=='\n')) c[--n]=0;
  if(!n) return;

  Serial.print(F("[CMD] ")); Serial.println(c);
  tone(PIN_BUZZER, 2000, 70);

  // Códigos curtos
  if(eqIC(c,"B1")){ if(!semAgua){ setBomba(1); showMsg("Comando BT:","Bomba LIGADA!"); } else { showMsg("BLOQUEADO!","Res. Sem Agua!"); sendAck("bomba",0,"bloqueado_sem_agua"); } return; }
  if(eqIC(c,"B0")){ setBomba(0); showMsg("Comando BT:","Bomba DESLIGADA"); return; }
  if(eqIC(c,"B")){ if(!bombaOn){ if(!semAgua){ setBomba(1); showMsg("Comando BT:","Bomba LIGADA!"); } else { showMsg("BLOQUEADO!","Res. Sem Agua!"); sendAck("bomba",0,"bloqueado_sem_agua"); } } else { setBomba(0); showMsg("Comando BT:","Bomba DESLIGADA"); } return; }
  if(eqIC(c,"V1")){ setVent(1); showMsg("Comando BT:","Ventoinha LIGADA"); return; }
  if(eqIC(c,"V0")){ setVent(0); showMsg("Comando BT:","Ventoinha DESL."); return; }
  if(eqIC(c,"V")){ setVent(!ventOn); showMsg("Comando BT:", ventOn?"Ventoinha LIGADA":"Ventoinha DESL."); return; }
  if(eqIC(c,"A1")){ autoBomba=1; sendAck("auto_bomba",1,"ok"); showMsg("Auto Bomba:","ATIVADO"); return; }
  if(eqIC(c,"A0")){ autoBomba=0; sendAck("auto_bomba",0,"ok"); showMsg("Auto Bomba:","DESATIVADO"); return; }
  if(eqIC(c,"C1")){ autoVent=1; sendAck("auto_ventoinha",1,"ok"); showMsg("Auto Vent:","ATIVADO"); return; }
  if(eqIC(c,"C0")){ autoVent=0; sendAck("auto_ventoinha",0,"ok"); showMsg("Auto Vent:","DESATIVADO"); return; }
  if(eqIC(c,"S")||eqIC(c,"sync")){ startSync(); return; }
  if(eqIC(c,"T")||eqIC(c,"status")){ sendTelem(); return; }
  // Alternar tela do LCD
  if(eqIC(c,"L")||eqIC(c,"lcd")||eqIC(c,"lcd_toggle")){
    tela = (tela == 1) ? 2 : 1;
    showMsg("LCD Tela:", tela==1?"Temp/Umidade":"Solo/Reserv.");
    return;
  }

  // Tokens longos (auto_* ANTES de bomba/vent)
  bool isAB = hasTok(c,"auto_bomba")||hasTok(c,"autobomba")||hasTok(c,"auto_bomba_1")||hasTok(c,"auto_bomba_0")||hasTok(c,"auto_bomba_on")||hasTok(c,"auto_bomba_off");
  bool isAV = hasTok(c,"auto_ventoinha")||hasTok(c,"autoventoinha")||hasTok(c,"auto_ventoinha_1")||hasTok(c,"auto_ventoinha_0")||hasTok(c,"auto_ventoinha_on")||hasTok(c,"auto_ventoinha_off");
  bool isB  = hasTok(c,"bomba")||hasTok(c,"pump")||hasTok(c,"agua")||hasTok(c,"bomba_on")||hasTok(c,"bomba_off")||hasTok(c,"bomba_1")||hasTok(c,"bomba_0")||hasTok(c,"bomba_toggle");
  bool isV  = hasTok(c,"ventoinha")||hasTok(c,"fan")||hasTok(c,"ventilador")||hasTok(c,"cooler")||hasTok(c,"ventoinha_on")||hasTok(c,"ventoinha_off")||hasTok(c,"ventoinha_1")||hasTok(c,"ventoinha_0")||hasTok(c,"ventoinha_toggle");

  int v = getVal(c);
  if(v<0){
    if(hasTok(c,"bomba_on")||hasTok(c,"bomba_1")) v=1;
    else if(hasTok(c,"bomba_off")||hasTok(c,"bomba_0")) v=0;
    else if(hasTok(c,"bomba_toggle")) v=2;
    else if(hasTok(c,"ventoinha_on")||hasTok(c,"ventoinha_1")) v=1;
    else if(hasTok(c,"ventoinha_off")||hasTok(c,"ventoinha_0")) v=0;
    else if(hasTok(c,"ventoinha_toggle")) v=2;
    else if(hasTok(c,"auto_bomba_on")||hasTok(c,"auto_bomba_1")) v=1;
    else if(hasTok(c,"auto_bomba_off")||hasTok(c,"auto_bomba_0")) v=0;
    else if(hasTok(c,"auto_ventoinha_on")||hasTok(c,"auto_ventoinha_1")) v=1;
    else if(hasTok(c,"auto_ventoinha_off")||hasTok(c,"auto_ventoinha_0")) v=0;
  }

  if(isAB){ if(v==2) autoBomba=!autoBomba; else if(v>=0) autoBomba=(v==1); else autoBomba=1; sendAck("auto_bomba",autoBomba?1:0,"ok"); showMsg("Auto Bomba:",autoBomba?"ATIVADO":"DESATIVADO"); return; }
  if(isAV){ if(v==2) autoVent=!autoVent; else if(v>=0) autoVent=(v==1); else autoVent=1; sendAck("auto_ventoinha",autoVent?1:0,"ok"); showMsg("Auto Vent:",autoVent?"ATIVADO":"DESATIVADO"); return; }
  if(isB){
    if(v==2){ if(!bombaOn){ if(!semAgua){ setBomba(1); showMsg("Comando BT:","Bomba LIGADA!"); } else { showMsg("BLOQUEADO!","Res. Sem Agua!"); sendAck("bomba",0,"bloqueado_sem_agua"); } } else { setBomba(0); showMsg("Comando BT:","Bomba DESLIGADA"); } }
    else if(v==1){ if(!semAgua){ setBomba(1); showMsg("Comando BT:","Bomba LIGADA!"); } else { showMsg("BLOQUEADO!","Res. Sem Agua!"); sendAck("bomba",0,"bloqueado_sem_agua"); } }
    else if(v==0){ setBomba(0); showMsg("Comando BT:","Bomba DESLIGADA"); }
    return;
  }
  if(isV){ if(v==2) setVent(!ventOn); else if(v==1) setVent(1); else if(v==0) setVent(0); showMsg("Comando BT:",ventOn?"Ventoinha LIGADA":"Ventoinha DESL."); return; }
  if(hasTok(c,"sync")||hasTok(c,"sincronizar")){ startSync(); return; }
  if(hasTok(c,"status")||hasTok(c,"telemetria")){ sendTelem(); return; }
}

// =========================================================================================
// LCD MSG RÁPIDA
// =========================================================================================
void showMsg(const char* a, const char* b) {
  strncpy(msg0, a, 16); msg0[16]=0;
  strncpy(msg1, b, 16); msg1[16]=0;
  showingMsg = true; tMsgExp = millis() + 1500;
  lcd.clear(); lcd.print(msg0); lcd.setCursor(0,1); lcd.print(msg1);
}

// =========================================================================================
// DESENHA TELA ATUAL DO LCD (chamado ao alternar tela ou após msg expirar)
// =========================================================================================
void drawCurrentScreen() {
  lcd.clear();
  if (tela == 1) {
    // Tela 1: Temperatura, Umidade Ar, Bluetooth
    lcd.print(F("T:")); lcd.print(temp, 1); lcd.print(F("C"));
    lcd.setCursor(8,0); lcd.print(F(" U.Ar:")); lcd.print((int)humAr); lcd.print('%');
    lcd.setCursor(0,1); lcd.print(btOn ? F("BT:Conectado") : F("BT:Offline"));
  } else {
    // Tela 2: Umidade Solo, Nível Reservatório
    lcd.print(F("U.Solo:")); lcd.print(humSolo); lcd.print('%');
    lcd.setCursor(0,1);
    if (semAgua) { lcd.print(F("AGUA CRITICA!")); }
    else { lcd.print(F("Reserv.:")); lcd.print(nivAgua); lcd.print('%'); }
  }
}