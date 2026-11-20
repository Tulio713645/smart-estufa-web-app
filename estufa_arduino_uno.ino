/*
 * =========================================================================================
 * AGROLINK - FIRMWARE OFICIAL ARDUINO UNO
 * Comunicação: Bluetooth Clássico (HC-05) + Sensor Ultrassônico + Log Offline
 * Arquivo: estufa_arduino_uno.ino
 * =========================================================================================
 *
 * Mapeamento Rigoroso de Pinos:
 *  - Pino 2 (RX): SoftwareSerial RX (Conectar ao TX do módulo Bluetooth HC-05)
 *  - Pino 3 (TX): SoftwareSerial TX (Conectar ao RX do HC-05 via divisor de tensão)
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
 *
 * PROTOCOLO SERIAL (9600 baud, uma linha por mensagem, terminada em "\n")
 *  - Comandos recebidos: B1/B0 (bomba), V1/V0 (ventoinha), A1/A0 (auto bomba),
 *    C1/C0 (auto ventoinha), S (sincronizar offline), T (telemetria).
 *    Também aceita formas textuais (bomba_on, "auto_bomba", etc.) e JSON
 *    ({"cmd":"bomba","val":1}).
 *  - Telemetria:  {"temp":25.4,"umidade_ar":65,...,"bt_online":1}
 *  - Confirmação: {"ack":"bomba","estado":1,"status":"ok"}
 *  - Lote offline: {"sync_start":N} + N x {"sync_item":{...}} + {"sync_end":true,"count":N}
 * =========================================================================================
 *
 * GESTÃO DE MEMÓRIA (Arduino Uno: 2048 bytes de SRAM)
 *  - NENHUMA alocação dinâmica: não existem objetos String, nem malloc/free.
 *    Todo o tráfego é montado com buffers char[] fixos e impresso diretamente.
 *  - O log offline usa registros compactos de 6 bytes (ver RegistroOffline).
 * =========================================================================================
 */

#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <DHT.h>
#include <SoftwareSerial.h>
#include <avr/wdt.h>
#include <string.h>

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

// =========================================================================================
// LOG OFFLINE - REGISTRO COMPACTO DE EXATAMENTE 6 BYTES
// =========================================================================================
//  cicloHi/cicloLo : ciclo absoluto de 25 s desde o boot (16 bits, permite wrap-around seguro)
//  temp            : temperatura em °C (int8)
//  umidAr          : 7 bits = umidade do ar (0-100) | bit 7 = bomba ligada
//  umidSolo        : 7 bits = umidade do solo (0-100) | bit 7 = ventoinha ligada
//  nivelAgua       : 7 bits = nível do reservatório (0-100) | bit 7 = falta de água
// =========================================================================================
struct RegistroOffline {
  uint8_t cicloHi;
  uint8_t cicloLo;
  int8_t  temp;
  uint8_t umidAr;
  uint8_t umidSolo;
  uint8_t nivelAgua;
};  // sizeof == 6 (todos os membros têm 1 byte, sem padding)

const int MAX_REGISTROS_OFFLINE = 56;     // 56 x 25 s = ~23 minutos de histórico
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

// Guarda contra reentrância: um lote offline nunca é descarregado duas vezes
bool sincronizando = false;

// Temporizadores de ciclo geral
unsigned long ultimoTempoLeitura = 0;
const unsigned long intervaloLeitura = 600;      // Lê o solo a cada 600ms

unsigned long ultimoTempoDHT = 0;
const unsigned long intervaloDHT = 1500;         // DHT11 exige >= 1s entre leituras

unsigned long ultimoTempoUltrassom = 0;
const unsigned long intervaloUltrassom = 2000;   // HC-SR04 exige >= 2s entre medições

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

// Buffers de recepção serial (tamanho fixo: NENHUMA alocação dinâmica)
#define TAM_BUFFER_COMANDO 40
char bufferBT[TAM_BUFFER_COMANDO];
uint8_t lenBufferBT = 0;
char bufferUSB[TAM_BUFFER_COMANDO];
uint8_t lenBufferUSB = 0;

// =========================================================================================
// DECLARAÇÃO ANTECIPADA DE FUNÇÕES
// =========================================================================================
void acionarBomba(bool ligar);
void acionarVentoinha(bool ligar);
void enviarConfirmacao(const char* atuador, int estado, const char* status);
void enviarTelemetria();
void descarregarLoteOfflineParaApp();
void verificarComandosSeriais();
void processarComando(char* cmd);
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
    acionarBomba(false);
  }
}

// =========================================================================================
// CONTROLE DOS ATUADORES COM TRAVA DE SEGURANÇA
// =========================================================================================

void acionarBomba(bool ligar) {
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

void acionarVentoinha(bool ligar) {
  digitalWrite(PIN_VENTOINHA, ligar ? HIGH : LOW);
  ventoinhaLigada = ligar;
  enviarConfirmacao("ventoinha", ventoinhaLigada ? 1 : 0, "ok");
}

// =========================================================================================
// COMUNICAÇÃO BLUETOOTH SERIAL (TELEMETRIA E CONFIRMAÇÕES)
// Montagem sem String: cada campo é impresso direto no stream (nenhum heap utilizado)
// =========================================================================================

void enviarTelemetria() {
  btSerial.print(F("{\"temp\":"));
  btSerial.print(temperatura, 1);
  btSerial.print(F(",\"umidade_ar\":"));
  btSerial.print((int)umidadeAr);
  btSerial.print(F(",\"umidade_solo\":"));
  btSerial.print(umidadeSoloPorcento);
  btSerial.print(F(",\"nivel_agua\":"));
  btSerial.print(nivelAguaPorcento);
  btSerial.print(F(",\"status_agua\":\""));
  btSerial.print(faltaAgua ? F("BAIXO") : F("OK"));
  btSerial.print(F("\",\"falta_agua\":"));
  btSerial.print(faltaAgua ? 1 : 0);
  btSerial.print(F(",\"dist_cm\":"));
  btSerial.print((int)distanciaUltrassomCm);
  btSerial.print(F(",\"bomba\":"));
  btSerial.print(bombaLigada ? 1 : 0);
  btSerial.print(F(",\"ventoinha\":"));
  btSerial.print(ventoinhaLigada ? 1 : 0);
  btSerial.print(F(",\"auto_bomba\":"));
  btSerial.print(autoBomba ? 1 : 0);
  btSerial.print(F(",\"auto_ventoinha\":"));
  btSerial.print(autoVentoinha ? 1 : 0);
  btSerial.print(F(",\"bt_online\":"));
  btSerial.print(bluetoothConectado ? 1 : 0);
  btSerial.print(F("}\n"));

  Serial.print(F("[BT TELEMETRIA] "));
  Serial.print(temperatura, 1);
  Serial.print(F(" C | solo "));
  Serial.print(umidadeSoloPorcento);
  Serial.print(F("% | agua "));
  Serial.print(nivelAguaPorcento);
  Serial.println(F("%"));
}

void enviarConfirmacao(const char* atuador, int estado, const char* status) {
  btSerial.print(F("{\"ack\":\""));
  btSerial.print(atuador);
  btSerial.print(F("\",\"estado\":"));
  btSerial.print(estado);
  btSerial.print(F(",\"status\":\""));
  btSerial.print(status);
  btSerial.print(F("\"}\n"));

  Serial.print(F("[BT ACK] "));
  Serial.print(atuador);
  Serial.print(F(" = "));
  Serial.print(estado);
  Serial.print(F(" ("));
  Serial.print(status);
  Serial.println(F(")"));
}

// =========================================================================================
// SISTEMA DE LOG OFFLINE E SINCRONIZAÇÃO EM LOTE
// =========================================================================================

void gravarRegistroOffline() {
  if (totalRegistrosOffline < MAX_REGISTROS_OFFLINE) {
    totalRegistrosOffline++;
  }

  RegistroOffline &reg = bufferOffline[indiceGravacaoOffline];

  // Ciclo absoluto de 25 s desde o boot (wraps a cada 65535 ciclos = ~18 dias)
  uint16_t ciclo = (uint16_t)(millis() / intervaloLogOffline);
  reg.cicloHi = (uint8_t)(ciclo >> 8);
  reg.cicloLo = (uint8_t)(ciclo & 0xFF);
  reg.temp = (int8_t)constrain((int)round(temperatura), -100, 100);
  reg.umidAr = (uint8_t)(constrain((int)umidadeAr, 0, 100) & 0x7F);
  reg.umidSolo = (uint8_t)(constrain(umidadeSoloPorcento, 0, 100) & 0x7F);
  reg.nivelAgua = (uint8_t)(constrain(nivelAguaPorcento, 0, 100) & 0x7F);

  // Flags guardadas nos bits 7 (livres, pois os percentuais vão de 0 a 100)
  if (bombaLigada) reg.umidAr |= 0x80;
  if (ventoinhaLigada) reg.umidSolo |= 0x80;
  if (faltaAgua) reg.nivelAgua |= 0x80;

  indiceGravacaoOffline = (indiceGravacaoOffline + 1) % MAX_REGISTROS_OFFLINE;

  Serial.print(F("[LOG OFFLINE] Registro gravado na RAM. Total: "));
  Serial.println(totalRegistrosOffline);
}

void descarregarLoteOfflineParaApp() {
  // Trava de reentrância: ignora pedidos de sincronização enquanto um lote está em voo
  if (sincronizando) {
    Serial.println(F("[SYNC] Sincronizacao ja em andamento, pedido ignorado."));
    return;
  }

  if (totalRegistrosOffline == 0) {
    Serial.println(F("[SYNC] Nenhum dado offline acumulado."));
    enviarTelemetria();
    return;
  }

  sincronizando = true;

  Serial.print(F("[SYNC] Descarregando lote de "));
  Serial.print(totalRegistrosOffline);
  Serial.println(F(" leituras offline para o aplicativo..."));

  // 1. Notifica início da sincronização
  btSerial.print(F("{\"sync_start\":"));
  btSerial.print(totalRegistrosOffline);
  btSerial.print(F("}\n"));
  delay(25);

  int inicio = (indiceGravacaoOffline - totalRegistrosOffline + MAX_REGISTROS_OFFLINE) % MAX_REGISTROS_OFFLINE;
  uint16_t cicloAgora = (uint16_t)(millis() / intervaloLogOffline);

  // 2. Transmite cada registro offline linha a linha
  for (int i = 0; i < totalRegistrosOffline; i++) {
    wdt_reset();

    // Processa comandos seriais que possam chegar durante o streaming (evita travar botões!)
    verificarComandosSeriais();

    int idx = (inicio + i) % MAX_REGISTROS_OFFLINE;
    RegistroOffline &r = bufferOffline[idx];

    // Diferença de ciclos em aritmética de 16 bits (wrap-around seguro)
    uint16_t atrasoCiclos = (uint16_t)(cicloAgora - ((uint16_t)((uint16_t)r.cicloHi << 8) | r.cicloLo));
    uint32_t segundosAtras = (uint32_t)atrasoCiclos * intervaloLogOffline;
    if (segundosAtras > 65535UL) segundosAtras = 65535UL;

    btSerial.print(F("{\"sync_item\":{\"t_offset\":"));
    btSerial.print((unsigned long)segundosAtras);
    btSerial.print(F(",\"temp\":"));
    btSerial.print((int)r.temp);
    btSerial.print(F(",\"umidade_ar\":"));
    btSerial.print((int)(r.umidAr & 0x7F));
    btSerial.print(F(",\"umidade_solo\":"));
    btSerial.print((int)(r.umidSolo & 0x7F));
    btSerial.print(F(",\"nivel_agua\":"));
    btSerial.print((int)(r.nivelAgua & 0x7F));
    btSerial.print(F(",\"bomba\":"));
    btSerial.print((r.umidAr & 0x80) ? 1 : 0);
    btSerial.print(F(",\"ventoinha\":"));
    btSerial.print((r.umidSolo & 0x80) ? 1 : 0);
    btSerial.print(F(",\"falta_agua\":"));
    btSerial.print((r.nivelAgua & 0x80) ? 1 : 0);
    btSerial.print(F("}}\n"));

    delay(10);
  }

  // 3. Notifica conclusão da sincronização
  btSerial.print(F("{\"sync_end\":true,\"count\":"));
  btSerial.print(totalRegistrosOffline);
  btSerial.print(F("}\n"));

  Serial.println(F("[SYNC] Sincronizacao offline concluida com sucesso!"));

  totalRegistrosOffline = 0;
  indiceGravacaoOffline = 0;
  sincronizando = false;

  soarBipeCurto();
}

// =========================================================================================
// ANÁLISE DE COMANDOS (SEM ALOCAÇÃO DINÂMICA)
// =========================================================================================

// Caracteres considered "separadores de palavra" (tudo o que não é letra, dígito ou '_')
bool ehSeparador(char c) {
  return !(((c >= 'a') && (c <= 'z')) || ((c >= 'A') && (c <= 'Z')) ||
           ((c >= '0') && (c <= '9')) || (c == '_'));
}

char paraMinusculo(char c) {
  return ((c >= 'A') && (c <= 'Z')) ? (char)(c + 32) : c;
}

// Compara duas strings inteiras ignorando maiúsculas/minúsculas (sem alocar memória)
bool textoIgual(const char* a, const char* b) {
  while (*a && *b) {
    if (paraMinusculo(*a) != paraMinusculo(*b)) return false;
    a++;
    b++;
  }
  return (*a == '\0') && (*b == '\0');
}

// Verifica se o texto contém a palavra informada como token independente.
// Ex.: "auto_bomba" NÃO casa com "bomba" (evita o bug que ligava a bomba ao alternar o modo automático)
bool contemToken(const char* texto, const char* token) {
  size_t lenToken = strlen(token);
  const char* p = texto;

  while (*p) {
    if (ehSeparador(*p)) {
      p++;
      continue;
    }

    const char* inicio = p;
    while (*p && !ehSeparador(*p)) p++;
    size_t lenPalavra = (size_t)(p - inicio);

    if (lenPalavra == lenToken) {
      bool igual = true;
      for (size_t i = 0; i < lenToken; i++) {
        if (paraMinusculo(inicio[i]) != paraMinusculo(token[i])) {
          igual = false;
          break;
        }
      }
      if (igual) return true;
    }
  }
  return false;
}

// Extrai o valor desejado de um comando: 0 = desligar, 1 = ligar, 2 = alternar, -1 = sem valor
int valorDoComando(const char* cmd) {
  if (contemToken(cmd, "toggle") || contemToken(cmd, "alternar") || contemToken(cmd, "inverter")) return 2;
  if (contemToken(cmd, "on") || contemToken(cmd, "ligar") || contemToken(cmd, "ativar") ||
      contemToken(cmd, "true") || contemToken(cmd, "1") || contemToken(cmd, "enable")) return 1;
  if (contemToken(cmd, "off") || contemToken(cmd, "desligar") || contemToken(cmd, "desativar") ||
      contemToken(cmd, "false") || contemToken(cmd, "0") || contemToken(cmd, "disable")) return 0;
  return -1;
}

void processarComando(char* cmd) {
  // Remove espaços iniciais e finais (o buffer é modificável, nada é copiado)
  while (*cmd == ' ' || *cmd == '\t') cmd++;
  size_t tamanho = strlen(cmd);
  while (tamanho > 0 && (cmd[tamanho - 1] == ' ' || cmd[tamanho - 1] == '\t' ||
                         cmd[tamanho - 1] == '\r' || cmd[tamanho - 1] == '\n')) {
    cmd[--tamanho] = '\0';
  }
  if (tamanho == 0) return;

  Serial.print(F("[CMD RECEBIDO] "));
  Serial.println(cmd);

  soarBipeCurto();

  // ---------------------------------------------------------------------------------------
  // 1. CÓDIGOS CURTOS (comparação exata, ignorando caixa)
  // ---------------------------------------------------------------------------------------
  if (textoIgual(cmd, "B1")) {
    if (!faltaAgua) {
      acionarBomba(true);
      exibirMensagemRapida("Comando BT:", "Bomba LIGADA!");
    } else {
      exibirMensagemRapida("BLOQUEADO!", "Res. Sem Agua!");
      enviarConfirmacao("bomba", 0, "bloqueado_sem_agua");
    }
    return;
  }
  if (textoIgual(cmd, "B0")) {
    acionarBomba(false);
    exibirMensagemRapida("Comando BT:", "Bomba DESLIGADA");
    return;
  }
  if (textoIgual(cmd, "B")) {
    if (!bombaLigada) {
      if (!faltaAgua) {
        acionarBomba(true);
        exibirMensagemRapida("Comando BT:", "Bomba LIGADA!");
      } else {
        exibirMensagemRapida("BLOQUEADO!", "Res. Sem Agua!");
        enviarConfirmacao("bomba", 0, "bloqueado_sem_agua");
      }
    } else {
      acionarBomba(false);
      exibirMensagemRapida("Comando BT:", "Bomba DESLIGADA");
    }
    return;
  }
  if (textoIgual(cmd, "V1")) {
    acionarVentoinha(true);
    exibirMensagemRapida("Comando BT:", "Ventoinha LIGADA");
    return;
  }
  if (textoIgual(cmd, "V0")) {
    acionarVentoinha(false);
    exibirMensagemRapida("Comando BT:", "Ventoinha DESL.");
    return;
  }
  if (textoIgual(cmd, "V")) {
    acionarVentoinha(!ventoinhaLigada);
    exibirMensagemRapida("Comando BT:", ventoinhaLigada ? "Ventoinha LIGADA" : "Ventoinha DESL.");
    return;
  }
  if (textoIgual(cmd, "A1")) {
    autoBomba = true;
    enviarConfirmacao("auto_bomba", 1, "ok");
    exibirMensagemRapida("Auto Bomba:", "ATIVADO");
    return;
  }
  if (textoIgual(cmd, "A0")) {
    autoBomba = false;
    enviarConfirmacao("auto_bomba", 0, "ok");
    exibirMensagemRapida("Auto Bomba:", "DESATIVADO");
    return;
  }
  if (textoIgual(cmd, "C1")) {
    autoVentoinha = true;
    enviarConfirmacao("auto_ventoinha", 1, "ok");
    exibirMensagemRapida("Auto Vent:", "ATIVADO");
    return;
  }
  if (textoIgual(cmd, "C0")) {
    autoVentoinha = false;
    enviarConfirmacao("auto_ventoinha", 0, "ok");
    exibirMensagemRapida("Auto Vent:", "DESATIVADO");
    return;
  }
  if (textoIgual(cmd, "S") || textoIgual(cmd, "sync")) {
    descarregarLoteOfflineParaApp();
    return;
  }
  if (textoIgual(cmd, "T") || textoIgual(cmd, "status")) {
    enviarTelemetria();
    return;
  }

  // ---------------------------------------------------------------------------------------
  // 2. COMANDOS POR PALAVRA / JSON ({"cmd":"bomba","val":1})
  //    As formas automáticas são avaliadas ANTES das manuais para que
  //    "auto_bomba" nunca seja interpretado como "bomba".
  // ---------------------------------------------------------------------------------------
  bool ehAutoBomba = contemToken(cmd, "auto_bomba") || contemToken(cmd, "autobomba") ||
                     contemToken(cmd, "auto_bomba_1") || contemToken(cmd, "auto_bomba_0") ||
                     contemToken(cmd, "auto_bomba_on") || contemToken(cmd, "auto_bomba_off");
  bool ehAutoVentoinha = contemToken(cmd, "auto_ventoinha") || contemToken(cmd, "autoventoinha") ||
                         contemToken(cmd, "auto_ventoinha_1") || contemToken(cmd, "auto_ventoinha_0") ||
                         contemToken(cmd, "auto_ventoinha_on") || contemToken(cmd, "auto_ventoinha_off");
  bool ehBomba = contemToken(cmd, "bomba") || contemToken(cmd, "pump") || contemToken(cmd, "agua") ||
                 contemToken(cmd, "bomba_on") || contemToken(cmd, "bomba_off") ||
                 contemToken(cmd, "bomba_1") || contemToken(cmd, "bomba_0") ||
                 contemToken(cmd, "bomba_toggle");
  bool ehVentoinha = contemToken(cmd, "ventoinha") || contemToken(cmd, "fan") ||
                     contemToken(cmd, "ventilador") || contemToken(cmd, "cooler") ||
                     contemToken(cmd, "ventoinha_on") || contemToken(cmd, "ventoinha_off") ||
                     contemToken(cmd, "ventoinha_1") || contemToken(cmd, "ventoinha_0") ||
                     contemToken(cmd, "ventoinha_toggle");

  int valor = valorDoComando(cmd);

  // Formas "coladas" (bomba_on / bomba_off / bomba_toggle) não expõem o valor como token solto
  if (valor < 0) {
    if (contemToken(cmd, "bomba_on") || contemToken(cmd, "bomba_1")) valor = 1;
    else if (contemToken(cmd, "bomba_off") || contemToken(cmd, "bomba_0")) valor = 0;
    else if (contemToken(cmd, "bomba_toggle")) valor = 2;
    else if (contemToken(cmd, "ventoinha_on") || contemToken(cmd, "ventoinha_1")) valor = 1;
    else if (contemToken(cmd, "ventoinha_off") || contemToken(cmd, "ventoinha_0")) valor = 0;
    else if (contemToken(cmd, "ventoinha_toggle")) valor = 2;
    else if (contemToken(cmd, "auto_bomba_on") || contemToken(cmd, "auto_bomba_1")) valor = 1;
    else if (contemToken(cmd, "auto_bomba_off") || contemToken(cmd, "auto_bomba_0")) valor = 0;
    else if (contemToken(cmd, "auto_ventoinha_on") || contemToken(cmd, "auto_ventoinha_1")) valor = 1;
    else if (contemToken(cmd, "auto_ventoinha_off") || contemToken(cmd, "auto_ventoinha_0")) valor = 0;
  }

  // --- 3. MODO AUTOMÁTICO DA BOMBA ---
  if (ehAutoBomba) {
    if (valor == 2) autoBomba = !autoBomba;
    else if (valor >= 0) autoBomba = (valor == 1);
    else autoBomba = true;

    enviarConfirmacao("auto_bomba", autoBomba ? 1 : 0, "ok");
    exibirMensagemRapida("Auto Bomba:", autoBomba ? "ATIVADO" : "DESATIVADO");
    return;
  }

  // --- 4. MODO AUTOMÁTICO DA VENTOINHA ---
  if (ehAutoVentoinha) {
    if (valor == 2) autoVentoinha = !autoVentoinha;
    else if (valor >= 0) autoVentoinha = (valor == 1);
    else autoVentoinha = true;

    enviarConfirmacao("auto_ventoinha", autoVentoinha ? 1 : 0, "ok");
    exibirMensagemRapida("Auto Vent:", autoVentoinha ? "ATIVADO" : "DESATIVADO");
    return;
  }

  // --- 5. BOMBA D'ÁGUA (PINO 10) ---
  if (ehBomba) {
    if (valor == 2) {
      if (!bombaLigada) {
        if (!faltaAgua) {
          acionarBomba(true);
          exibirMensagemRapida("Comando BT:", "Bomba LIGADA!");
        } else {
          exibirMensagemRapida("BLOQUEADO!", "Res. Sem Agua!");
          enviarConfirmacao("bomba", 0, "bloqueado_sem_agua");
        }
      } else {
        acionarBomba(false);
        exibirMensagemRapida("Comando BT:", "Bomba DESLIGADA");
      }
    } else if (valor == 1) {
      if (!faltaAgua) {
        acionarBomba(true);
        exibirMensagemRapida("Comando BT:", "Bomba LIGADA!");
      } else {
        exibirMensagemRapida("BLOQUEADO!", "Res. Sem Agua!");
        enviarConfirmacao("bomba", 0, "bloqueado_sem_agua");
      }
    } else if (valor == 0) {
      acionarBomba(false);
      exibirMensagemRapida("Comando BT:", "Bomba DESLIGADA");
    }
    return;
  }

  // --- 6. VENTOINHA (PINO 13) ---
  if (ehVentoinha) {
    if (valor == 2) {
      acionarVentoinha(!ventoinhaLigada);
    } else if (valor == 1) {
      acionarVentoinha(true);
    } else if (valor == 0) {
      acionarVentoinha(false);
    }
    exibirMensagemRapida("Comando BT:", ventoinhaLigada ? "Ventoinha LIGADA" : "Ventoinha DESL.");
    return;
  }

  // --- 7. SINCRONIZAÇÃO OFFLINE ---
  if (contemToken(cmd, "sync") || contemToken(cmd, "sincronizar")) {
    descarregarLoteOfflineParaApp();
    return;
  }

  // --- 8. STATUS / TELEMETRIA ---
  if (contemToken(cmd, "status") || contemToken(cmd, "telemetria")) {
    enviarTelemetria();
    return;
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
// RECEPÇÃO DE COMANDOS (BLUETOOTH E USB) - SEM ALOCAÇÃO DINÂMICA
// =========================================================================================

void processarLinha(char* buffer, uint8_t& tamanho) {
  if (tamanho > 0) {
    buffer[tamanho] = '\0';
    processarComando(buffer);
    tamanho = 0;
  }
}

void acumularCaractere(char* buffer, uint8_t& tamanho, char c) {
  if (c == '\n' || c == '\r') {
    processarLinha(buffer, tamanho);
  } else if (tamanho < (TAM_BUFFER_COMANDO - 1)) {
    buffer[tamanho++] = c;
  } else {
    // Linha maior que o buffer: descarta o conteúdo para não corromper o parser
    tamanho = 0;
  }
}

void verificarComandosSeriais() {
  while (btSerial.available() > 0) {
    char c = (char)btSerial.read();
    acumularCaractere(bufferBT, lenBufferBT, c);
  }

  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    acumularCaractere(bufferUSB, lenBufferUSB, c);
  }
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
    ultimoTempoLogOffline = millis();
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

    // A. Leitura do Higrômetro do Solo (Pino A0)
    int soloBruto = analogRead(PIN_SOLO);
    umidadeSoloPorcento = map(soloBruto, LIMITE_SOLO_SECO_VAL, LIMITE_SOLO_MOLHADO_VAL, 0, 100);
    umidadeSoloPorcento = constrain(umidadeSoloPorcento, 0, 100);
  }

  // A DHT11 exige no mínimo 1 segundo entre leituras
  if (tempoAtual - ultimoTempoDHT >= intervaloDHT) {
    ultimoTempoDHT = tempoAtual;

    float t = dht.readTemperature();
    float h = dht.readHumidity();
    if (!isnan(t)) temperatura = t;
    if (!isnan(h)) umidadeAr = h;
  }

  // O HC-SR04 exige no mínimo 2 segundos entre medições
  if (tempoAtual - ultimoTempoUltrassom >= intervaloUltrassom) {
    ultimoTempoUltrassom = tempoAtual;

    // B. Leitura do Sensor Ultrassônico (Pinos 4 e 5) - Nível de Água
    atualizarNivelAgua();

    // C. Alerta sonoro periódico caso o reservatório esteja vazio
    if (faltaAgua) {
      if (tempoAtual - ultimoAlertaBuzzer >= 4500) {
        ultimoAlertaBuzzer = tempoAtual;
        soarBipeAlertaAguaCritica();
      }
    }

    // D. Automação Inteligente da Bomba de Água
    if (autoBomba && !faltaAgua) {
      if (umidadeSoloPorcento < 40 && !bombaLigada) {
        acionarBomba(true);
      }
      else if (umidadeSoloPorcento >= 75 && bombaLigada) {
        acionarBomba(false);
      }
    }

    // E. Automação Inteligente da Ventoinha
    if (autoVentoinha) {
      if (temperatura > TEMP_IDEAL_MAX && !ventoinhaLigada) {
        acionarVentoinha(true);
      }
      else if (temperatura <= TEMP_IDEAL_MIN && ventoinhaLigada) {
        acionarVentoinha(false);
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
