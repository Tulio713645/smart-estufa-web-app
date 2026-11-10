/*
 * =========================================================================================
 * ESTUFA INTELIGENTE - CÓDIGO ARDUINO UNO + BLUETOOTH (HC-05 / HC-06 / HM-10)
 * Arquivo: estufa_hardware.ino
 * =========================================================================================
 * 
 * Baseado no código original do usuário com:
 *  - Sensor DHT11 no Pino Digital 6
 *  - Relé da Bomba de Água no Pino Digital 10 (Active-Low)
 *  - Sensor de Umidade do Solo no Pino Analógico A0
 *  - Display LCD 16x2 com I2C (0x27) com Ícones Customizados de Termômetro e Gota
 *  - Comunicação Bluetooth (SoftwareSerial nos Pinos 2 e 3 + Serial USB nos Pinos 0 e 1)
 *  - Preparado para Sensor de Nível de Água (Pino 7) e Ventoinha (Pino 8)
 * =========================================================================================
 */

#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <DHT.h>
#include <SoftwareSerial.h>

// --- PINOS E CONFIGURAÇÕES DO USUÁRIO ---
#define DHTPIN 6
#define DHTTYPE DHT11
#define PIN_RELE 10       // Relé da Bomba de Água (Active-Low)
#define PIN_SOLO A0       // Higrômetro do Solo Analógico

// --- PINOS DE COMUNICAÇÃO BLUETOOTH ---
// Conecte o módulo Bluetooth nos pinos 2 e 3:
//   - Pino 2 (RX do Arduino) <--- Conectar no TX do módulo Bluetooth
//   - Pino 3 (TX do Arduino) ---> Conectar no RX do módulo Bluetooth (via divisor se for 3.3V)
#define PIN_BT_RX 2
#define PIN_BT_TX 3

// --- PINOS PREPARADOS PARA AMANHÃ ---
#define PIN_BOIA 7        // Boia de Nível de Água (quando for instalar amanhã)
#define PIN_VENTOINHA 8   // Relé da Ventoinha / Cooler (quando for instalar amanhã)

// Inicialização dos Sensores, Display e Bluetooth
DHT dht(DHTPIN, DHTTYPE);
LiquidCrystal_I2C lcd(0x27, 16, 2);
SoftwareSerial btSerial(PIN_BT_RX, PIN_BT_TX);

// --- ÍCONES PERSONALIZADOS DO USUÁRIO (5x8 pixels) ---
byte iconeTermometro[8] = {
  B00100, //   *  
  B01010, //  * * 
  B01010, //  * * 
  B01010, //  * * 
  B01110, //  *** 
  B11111, // ***** 
  B11111, // ***** 
  B01110  //  *** 
};

byte iconeGotinha[8] = {
  B00100, //   *   
  B00100, //   *  
  B01110, //  *** 
  B01110, //  *** 
  B11111, // ***** 
  B11111, // ***** 
  B11111, // ***** 
  B01110  //  ***  
};

// --- CALIBRAÇÃO DO SENSOR DE UMIDADE DO SOLO ---
const int LIMITE_SECO = 850;   
const int LIMITE_MOLHADO = 300; 
const int UMIDADE_LIGAR_REGA = 30; 

// Controle de Tempo e Telas
unsigned long ultimoTempoLeitura = 0;
const long intervaloLeitura = 500; // Lê sensores a cada 500ms

unsigned long ultimaTrocaTela = 0;
const long tempoExibicaoTela = 3000; // Alterna LCD a cada 3 segundos
int telaAtual = 1;

// Envio de telemetria via Bluetooth a cada 1500ms
unsigned long ultimoEnvioBT = 0;
const long intervaloEnvioBT = 1500;

// Variáveis globais para guardar os dados
int porcentagemSolo = 0;
float tempAr = 0;
float humAr = 0;
bool bombaLigada = false;
bool ventoinhaLigada = false;

// Controle Manual via Bluetooth vs Automático
bool controleManualBomba = false;
unsigned long tempoFimManualBomba = 0;

// Buffer de comandos seriais
char bufferComando[32];
uint8_t idxCmd = 0;

// =========================================================================================
// FUNÇÕES AUXILIARES
// =========================================================================================

// Envia telemetria JSON para o App Web (via Bluetooth nos pinos 2/3 e USB nos pinos 0/1)
void enviarTelemetriaBluetooth() {
  // Monta JSON compatível com o aplicativo Web
  // {"temp":25.5,"umidade_ar":60,"umidade_solo":45,"nivel_agua":"OK","bomba":0,"ventoinha":0}
  String json = F("{\"temp\":");
  json += String(tempAr, 1);
  json += F(",\"umidade_ar\":");
  json += String((int)humAr);
  json += F(",\"umidade_solo\":");
  json += String(porcentagemSolo);
  json += F(",\"nivel_agua\":\"OK\","); // Fixo OK enquanto não coloca a boia amanhã
  json += F("\"bomba\":");
  json += String(bombaLigada ? 1 : 0);
  json += F(",\"ventoinha\":");
  json += String(ventoinhaLigada ? 1 : 0);
  json += F("}\n");

  // Envia no Bluetooth e no Monitor Serial USB ao mesmo tempo
  btSerial.print(json);
  Serial.print(json);
}

// Processa comandos enviados pelo App Web via Bluetooth
void processarComando(const char* cmd) {
  Serial.print(F("[BT COMANDO]: "));
  Serial.println(cmd);

  // Comando: Alternar Bomba de Água
  if (strstr(cmd, "bomba_toggle") != NULL || strstr(cmd, "BOMBA") != NULL) {
    bombaLigada = !bombaLigada;
    digitalWrite(PIN_RELE, bombaLigada ? LOW : HIGH); // Active-Low: LOW liga, HIGH desliga
    
    // Ativa modo manual por 30 segundos (ou até o usuário alternar de novo)
    controleManualBomba = true;
    tempoFimManualBomba = millis() + 30000;

    // Feedback no LCD
    lcd.clear();
    lcd.setCursor(0, 0);
    lcd.print(F("COMANDO APP:"));
    lcd.setCursor(0, 1);
    lcd.print(bombaLigada ? F("BOMBA LIGADA!") : F("BOMBA DESLIGADA"));
    delay(1200);
    lcd.clear();

    enviarTelemetriaBluetooth();
  }
  // Comando: Alternar Ventoinha (preparado para amanhã)
  else if (strstr(cmd, "ventoinha_toggle") != NULL || strstr(cmd, "VENT") != NULL) {
    ventoinhaLigada = !ventoinhaLigada;
    digitalWrite(PIN_VENTOINHA, ventoinhaLigada ? LOW : HIGH);

    lcd.clear();
    lcd.setCursor(0, 0);
    lcd.print(F("COMANDO APP:"));
    lcd.setCursor(0, 1);
    lcd.print(ventoinhaLigada ? F("COOLER LIGADO!") : F("COOLER DESLIGADO"));
    delay(1200);
    lcd.clear();

    enviarTelemetriaBluetooth();
  }
  // Comando: Solicitar leitura imediata
  else if (strstr(cmd, "status") != NULL || strstr(cmd, "STATUS") != NULL) {
    enviarTelemetriaBluetooth();
  }
}

// =========================================================================================
// SETUP
// =========================================================================================
void setup() {
  Serial.begin(9600);       // Monitor Serial USB
  btSerial.begin(9600);     // Comunicação com o módulo Bluetooth HC-05 / HC-06 / HM-10
  
  pinMode(PIN_RELE, OUTPUT);
  digitalWrite(PIN_RELE, HIGH); // Relé Active-Low: HIGH desliga a bomba

  // Prepara os pinos adicionais para amanhã
  pinMode(PIN_VENTOINHA, OUTPUT);
  digitalWrite(PIN_VENTOINHA, HIGH); // Desligada inicialmente
  pinMode(PIN_BOIA, INPUT_PULLUP);

  lcd.init();
  lcd.backlight();
  dht.begin();

  // Registra os ícones na memória do LCD (0 e 1)
  lcd.createChar(0, iconeTermometro);
  lcd.createChar(1, iconeGotinha);

  // Contagem decrescente original do usuário (7 segundos)
  for (int i = 7; i > 0; i--) {
    lcd.clear();
    lcd.setCursor(0, 0);
    lcd.print(F("Estufa Automatica"));
    lcd.setCursor(0, 1);
    lcd.print(F("Iniciando em: "));
    lcd.print(i);
    lcd.print(F("s"));
    delay(1000);
  }

  lcd.clear();
  Serial.println(F("[ARDUINO] Estufa pronta e aguardando conexao Bluetooth..."));
}

// =========================================================================================
// LOOP PRINCIPAL
// =========================================================================================
void loop() {
  unsigned long tempoAtual = millis();

  // --- 1. LEITURA DE COMANDOS VINDOS DO BLUETOOTH (Pinos 2/3 ou Serial USB) ---
  while (btSerial.available() > 0) {
    char c = btSerial.read();
    if (c == '\n' || c == '\r') {
      if (idxCmd > 0) {
        bufferComando[idxCmd] = '\0';
        processarComando(bufferComando);
        idxCmd = 0;
      }
    } else if (idxCmd < sizeof(bufferComando) - 1) {
      bufferComando[idxCmd++] = c;
    }
  }

  while (Serial.available() > 0) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (idxCmd > 0) {
        bufferComando[idxCmd] = '\0';
        processarComando(bufferComando);
        idxCmd = 0;
      }
    } else if (idxCmd < sizeof(bufferComando) - 1) {
      bufferComando[idxCmd++] = c;
    }
  }

  // --- 2. ATUALIZAÇÃO PERIÓDICA DOS SENSORES E CONTROLE DA BOMBA ---
  if (tempoAtual - ultimoTempoLeitura >= intervaloLeitura) {
    ultimoTempoLeitura = tempoAtual;

    int leituraSoloPura = analogRead(PIN_SOLO);
    porcentagemSolo = map(leituraSoloPura, LIMITE_SECO, LIMITE_MOLHADO, 0, 100);
    porcentagemSolo = constrain(porcentagemSolo, 0, 100); 

    float t = dht.readTemperature();
    float h = dht.readHumidity();
    if (!isnan(t)) tempAr = t;
    if (!isnan(h)) humAr = h;

    // Se o usuário acionou a bomba manualmente pelo App, respeita o tempo manual
    if (controleManualBomba) {
      if (tempoAtual > tempoFimManualBomba) {
        controleManualBomba = false; // Retorna para controle automático após timeout
      }
    }

    // Controle Automático da Bomba (se não estiver em modo manual do app)
    if (!controleManualBomba) {
      if (porcentagemSolo < UMIDADE_LIGAR_REGA) {
        digitalWrite(PIN_RELE, LOW); // Liga a bomba (Active-Low)
        bombaLigada = true;
      } else {
        digitalWrite(PIN_RELE, HIGH); // Desliga a bomba
        bombaLigada = false;
      }
    }
  }

  // --- 3. ENVIO DE TELEMETRIA VIA BLUETOOTH PARA O CELULAR (a cada 1.5s) ---
  if (tempoAtual - ultimoEnvioBT >= intervaloEnvioBT) {
    ultimoEnvioBT = tempoAtual;
    enviarTelemetriaBluetooth();
  }

  // --- 4. ALTERNÂNCIA DE TELAS NO DISPLAY LCD (a cada 3s) ---
  if (tempoAtual - ultimaTrocaTela >= tempoExibicaoTela) {
    ultimaTrocaTela = tempoAtual;
    telaAtual = (telaAtual == 1) ? 2 : 1;
    lcd.clear();
  }

  // --- 5. EXIBIÇÃO NO LCD 16x2 COM ÍCONES DO USUÁRIO ---
  if (telaAtual == 1) {
    // Tela 1: Ambiente (Temperatura + Umidade do Ar com Ícone)
    lcd.setCursor(0, 0);
    lcd.print(F("Ambiente:"));
    
    lcd.setCursor(0, 1);
    lcd.write(byte(0)); // Ícone do Termômetro
    lcd.print((int)tempAr);
    lcd.print(F("C  "));
    
    lcd.print(F("Ar:"));
    lcd.print((int)humAr);
    lcd.print(F("%"));

  } else {
    // Tela 2: Umidade do Solo (com Ícone de Gota) + Status da Bomba (T:ON/OFF)
    lcd.setCursor(0, 0);
    lcd.print(F("Umidade Solo:"));
    
    lcd.setCursor(0, 1);
    lcd.write(byte(1)); // Ícone da Gotinha
    lcd.print(porcentagemSolo);
    lcd.print(F("% "));

    if (porcentagemSolo < UMIDADE_LIGAR_REGA) {
      lcd.print(F("Seco"));
    } else {
      lcd.print(F("Umido"));
    }

    lcd.setCursor(11, 1);
    if (bombaLigada) {
      lcd.print(F("T:ON "));
    } else {
      lcd.print(F("T:OFF"));
    }
  }
}
