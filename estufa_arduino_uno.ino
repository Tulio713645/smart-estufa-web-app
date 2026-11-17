/*
 * =========================================================================================
 * AGROLINK - FIRMWARE ARDUINO UNO PARA ESTUFA INTELIGENTE
 * Arquivo: estufa_arduino_uno.ino
 * =========================================================================================
 * 
 * Hardware mapeado:
 *  - Pino 6: Sensor DHT11 (Temperatura e Umidade do Ar)
 *  - Pino A0: Sensor Higrômetro do Solo (Analógico)
 *  - Pino A1: Sensor de Nível de Água no Reservatório (Analógico)
 *  - Pino 10: Relé da Bomba de Água
 *  - Pino 11: Buzzer Piezoelétrico (Alertas e Confirmações Sonoras)
 *  - Pino 13: Ventoinha / Cooler
 *  - Pino 2: Botão Físico Multifunção (INPUT_PULLUP)
 *  - Pinos 8 (RX) e 9 (TX): SoftwareSerial conectado ao adaptador Wi-Fi ESP-12E
 *  - I2C (A4=SDA, A5=SCL): Display LCD 16x2 com I2C no endereço 0x27
 * 
 * Recursos implementados:
 *  - Parâmetros agronômicos ideais reais (Temp 20-30°C, Solo 60-80% capacidade)
 *  - Trava de segurança por nível de água (Bomba NUNCA liga se o reservatório estiver baixo)
 *  - Chaves de modo automático independentes para Bomba e Ventoinha
 *  - Ações manuais a qualquer momento sincronizadas com o App AgroLink
 *  - Padrões de bipes sonoros personalizados no buzzer
 *  - Botão multifunção: 3s para Modo Config (se offline) ou Proteção de Desconexão (10s)
 *  - Watchdog Timer de 8 segundos contra travamentos
 *  - Comunicação bidirecional serial JSON com o ESP-12E
 * =========================================================================================
 */

#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <DHT.h>
#include <SoftwareSerial.h>
#include <avr/wdt.h>

// --- MAPEAMENTO DE PINOS ---
#define DHTPIN 6
#define DHTTYPE DHT11

const int sensorSoloPin = A0;   // Higrômetro de solo analógico
const int sensorAguaPin = A1;   // Sensor de nível do reservatório

#define PIN_BOMBA 10            // Relé da Bomba de Água
#define PIN_BUZZER 11           // Buzzer para alertas sonoros
#define PIN_VENTOINHA 13        // Relé / Driver da Ventoinha
#define PIN_BOTAO 2             // Botão físico multifunção (Pull-up interno)

// Comunicação serial com o adaptador Wi-Fi ESP-12E
#define PIN_ESP_RX 8            // RX do Arduino (conectar no TX do ESP-12E)
#define PIN_ESP_TX 9            // TX do Arduino (conectar no RX do ESP-12E via divisor)

// Inicialização dos módulos
DHT dht(DHTPIN, DHTTYPE);
LiquidCrystal_I2C lcd(0x27, 16, 2);
SoftwareSerial espSerial(PIN_ESP_RX, PIN_ESP_TX);

// --- ÍCONES PERSONALIZADOS PARA O LCD (5x8 pixels) ---
byte iconeTermometro[8] = {
  B00100, B01010, B01010, B01010, B01110, B11111, B11111, B01110
};

byte iconeGota[8] = {
  B00100, B00100, B01110, B01110, B11111, B11111, B11111, B01110
};

byte iconeWifi[8] = {
  B00000, B01110, B10001, B00100, B01010, B00000, B00100, B00000
};

byte iconeAlerta[8] = {
  B00100, B01110, B01110, B01110, B11111, B11111, B00100, B00000
};

// --- CALIBRAÇÃO AGRONÔMICA REAL PARA ESTUFA ---
// Umidade do Solo: 
// Abaixo de 40% (ou leitura analógica seca): solo seco -> liga irrigação
// Ao atingir 75-80%: ponto ideal de retenção hídrica -> desliga para não encharcar a raiz!
const int LIMITE_SOLO_SECO_VAL = 400;     // Leitura bruta no ar/solo seco
const int LIMITE_SOLO_MOLHADO_VAL = 800;  // Leitura bruta em solo saturado
const int LIMITE_AGUA_BAIXA_VAL = 300;    // Abaixo deste valor indica reservatório crítico
const float TEMP_IDEAL_MAX = 30.0;        // Acima de 30°C estresse térmico -> liga ventoinha
const float TEMP_IDEAL_MIN = 27.0;        // Ventoinha desliga quando resfria abaixo de 27°C

// --- VARIÁVEIS DE ESTADO DO SISTEMA ---
float temperatura = 0.0;
float umidadeAr = 0.0;
int umidadeSoloBruto = 0;
int umidadeSoloPorcento = 0;
int nivelAguaBruto = 0;
bool faltaAgua = false;

// Estado dos atuadores
bool bombaLigada = false;
bool ventoinhaLigada = false;

// Modos automáticos (podem ser ligados/desligados pelo App)
bool autoBomba = true;
bool autoVentoinha = true;

// Estado de conexão com a rede Wi-Fi / App
bool sistemaOnline = false;
bool emModoConfiguracao = false;

// Controle do Botão Físico
unsigned long tempoInicioPressionado = 0;
bool botaoEstavaPressionado = false;
bool emFluxoDesconexao = false;
unsigned long tempoInicioDesconexao = 0;
int segundosRestantesDesconexao = 10;

// Temporizadores de ciclo
unsigned long ultimoTempoLeitura = 0;
const unsigned long intervaloLeitura = 600;   // Lê sensores a cada 600ms

unsigned long ultimoTempoTelemetria = 0;
const unsigned long intervaloTelemetria = 1500; // Envia telemetria a cada 1.5s

unsigned long ultimoTempoLCD = 0;
const unsigned long tempoExibicaoTela = 3000;  // Alterna telas do LCD a cada 3s
int telaAtual = 1;

unsigned long ultimoAlertaAgua = 0;

// Buffer para comandos seriais recebidos do ESP-12E
String bufferSerial = "";

// =========================================================================================
// PADRÕES DE ALARME SONORO (BUZZER - PINO 11)
// =========================================================================================

// 1 Bipe curto (clique de botão / confirmação de comando)
void soarBipeCurto() {
  tone(PIN_BUZZER, 2000, 80);
}

// 2 Bipes rápidos (Wi-Fi conectado com sucesso)
void soarBipeConexaoSucesso() {
  tone(PIN_BUZZER, 2200, 100);
  delay(140);
  tone(PIN_BUZZER, 2600, 120);
}

// Bipe intermitente (Alerta de nível crítico de água)
void soarBipeAlertaAgua() {
  tone(PIN_BUZZER, 900, 150);
}

// Bipe longo (Entrada no modo de configuração de rede)
void soarBipeModoConfig() {
  tone(PIN_BUZZER, 1200, 800);
}

// Bipe duplo grave (Desconexão realizada)
void soarBipeDesconexao() {
  tone(PIN_BUZZER, 1000, 150);
  delay(180);
  tone(PIN_BUZZER, 700, 250);
}

// =========================================================================================
// CONTROLE DOS ATUADORES COM TRAVAS DE SEGURANÇA
// =========================================================================================

void acionarBomba(bool ligar, const char* motivo = "") {
  // Trava de segurança absoluta: Se não há água, a bomba JAMAIS liga
  if (ligar && faltaAgua) {
    digitalWrite(PIN_BOMBA, LOW);
    bombaLigada = false;
    Serial.println(F("[SEGURANCA] Tentativa de ligar bomba sem agua bloqueada!"));
    return;
  }

  if (ligar) {
    digitalWrite(PIN_BOMBA, HIGH);
    bombaLigada = true;
  } else {
    digitalWrite(PIN_BOMBA, LOW);
    bombaLigada = false;
  }

  // Envia confirmação imediata ao ESP-12E / App
  enviarConfirmacao("bomba", bombaLigada ? 1 : 0);
}

void acionarVentoinha(bool ligar, const char* motivo = "") {
  if (ligar) {
    digitalWrite(PIN_VENTOINHA, HIGH);
    ventoinhaLigada = true;
  } else {
    digitalWrite(PIN_VENTOINHA, LOW);
    ventoinhaLigada = false;
  }

  // Envia confirmação imediata ao ESP-12E / App
  enviarConfirmacao("ventoinha", ventoinhaLigada ? 1 : 0);
}

// =========================================================================================
// COMUNICAÇÃO SERIAL COM O ESP-12E (JSON TELEMETRIA E CONFIRMAÇÕES)
// =========================================================================================

void enviarTelemetria() {
  // Envia payload JSON completo formatado para o ESP-12E repassar via MQTT
  // {"temp":26.5,"umidade_ar":65,"umidade_solo":52,"nivel_agua":"OK","bomba":0,"ventoinha":0,"auto_bomba":1,"auto_ventoinha":1,"online":1}
  String json = F("{\"temp\":");
  json += String(temperatura, 1);
  json += F(",\"umidade_ar\":");
  json += String((int)umidadeAr);
  json += F(",\"umidade_solo\":");
  json += String(umidadeSoloPorcento);
  json += F(",\"nivel_agua\":\"");
  json += faltaAgua ? F("BAIXO") : F("OK");
  json += F("\",\"nivel_agua_val\":");
  json += String(nivelAguaBruto);
  json += F(",\"bomba\":");
  json += String(bombaLigada ? 1 : 0);
  json += F(",\"ventoinha\":");
  json += String(ventoinhaLigada ? 1 : 0);
  json += F(",\"auto_bomba\":");
  json += String(autoBomba ? 1 : 0);
  json += F(",\"auto_ventoinha\":");
  json += String(autoVentoinha ? 1 : 0);
  json += F(",\"online\":");
  json += String(sistemaOnline ? 1 : 0);
  json += F("}\n");

  espSerial.print(json);
  Serial.print(F("[TELEMETRIA] "));
  Serial.print(json);
}

void enviarConfirmacao(const char* atuador, int estado) {
  // Confirmação de recebimento e execução física
  String ack = F("{\"ack\":\"");
  ack += atuador;
  ack += F("\",\"estado\":");
  ack += String(estado);
  ack += F(",\"status\":\"ok\"}\n");

  espSerial.print(ack);
  Serial.print(F("[ACK] "));
  Serial.print(ack);
}

// =========================================================================================
// PROCESSAMENTO DE COMANDOS RECEBIDOS DO APLICATIVO AGROLINK
// =========================================================================================

void processarComando(String cmd) {
  cmd.trim();
  if (cmd.length() == 0) return;

  Serial.print(F("[CMD RECEBIDO] "));
  Serial.println(cmd);

  soarBipeCurto(); // Feedback sonoro de clique

  // Comando: Ligar / Desligar Bomba
  if (cmd.indexOf("\"cmd\":\"bomba\"") >= 0 || cmd.indexOf("bomba_toggle") >= 0) {
    if (cmd.indexOf("\"val\":1") >= 0 || (!bombaLigada && cmd.indexOf("bomba_toggle") >= 0)) {
      if (!faltaAgua) {
        acionarBomba(true, "App");
        exibirMensagemRapida("Comando do App:", "Bomba LIGADA!");
      } else {
        exibirMensagemRapida("BLOQUEADO!", "Reservat. Vazio");
      }
    } else {
      acionarBomba(false, "App");
      exibirMensagemRapida("Comando do App:", "Bomba DESLIGADA");
    }
  }
  // Comando: Ligar / Desligar Ventoinha
  else if (cmd.indexOf("\"cmd\":\"ventoinha\"") >= 0 || cmd.indexOf("ventoinha_toggle") >= 0) {
    if (cmd.indexOf("\"val\":1") >= 0 || (!ventoinhaLigada && cmd.indexOf("ventoinha_toggle") >= 0)) {
      acionarVentoinha(true, "App");
      exibirMensagemRapida("Comando do App:", "Ventoinha LIGADA");
    } else {
      acionarVentoinha(false, "App");
      exibirMensagemRapida("Comando do App:", "Ventoinha DESL.");
    }
  }
  // Comando: Alternar Automático da Bomba
  else if (cmd.indexOf("\"cmd\":\"auto_bomba\"") >= 0) {
    autoBomba = (cmd.indexOf("\"val\":1") >= 0);
    enviarConfirmacao("auto_bomba", autoBomba ? 1 : 0);
    exibirMensagemRapida("Modo Auto Bomba:", autoBomba ? "ATIVADO" : "DESATIVADO");
  }
  // Comando: Alternar Automático da Ventoinha
  else if (cmd.indexOf("\"cmd\":\"auto_ventoinha\"") >= 0) {
    autoVentoinha = (cmd.indexOf("\"val\":1") >= 0);
    enviarConfirmacao("auto_ventoinha", autoVentoinha ? 1 : 0);
    exibirMensagemRapida("Modo Auto Vento:", autoVentoinha ? "ATIVADO" : "DESATIVADO");
  }
  // Notificação do ESP-12E: Conectado ao Wi-Fi e Broker MQTT
  else if (cmd.indexOf("\"status\":\"online\"") >= 0) {
    if (!sistemaOnline) {
      sistemaOnline = true;
      emModoConfiguracao = false;
      soarBipeConexaoSucesso();
      exibirMensagemRapida("AgroLink Estufa", "Wi-Fi CONECTADO!");
    }
  }
  // Notificação do ESP-12E: Desconectado da rede
  else if (cmd.indexOf("\"status\":\"offline\"") >= 0) {
    sistemaOnline = false;
  }
  // Solicitação imediata de status
  else if (cmd.indexOf("\"cmd\":\"status\"") >= 0) {
    enviarTelemetria();
  }
}

// =========================================================================================
// MENSAGEM RÁPIDA NO LCD (FEEDBACK DE 1.2 SEGUNDOS)
// =========================================================================================

void exibirMensagemRapida(const char* linha0, const char* linha1) {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(linha0);
  lcd.setCursor(0, 1);
  lcd.print(linha1);
  delay(1200);
  lcd.clear();
  ultimoTempoLCD = millis(); // Reseta temporizador da tela
}

// =========================================================================================
// SETUP
// =========================================================================================

void setup() {
  Serial.begin(9600);
  espSerial.begin(9600);

  // Configuração dos pinos de saída
  pinMode(PIN_BOMBA, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_VENTOINHA, OUTPUT);
  
  // Botão multifunção com resistor de pull-up interno
  pinMode(PIN_BOTAO, INPUT_PULLUP);

  // Inicializa atuadores desligados
  digitalWrite(PIN_BOMBA, LOW);
  digitalWrite(PIN_BUZZER, LOW);
  digitalWrite(PIN_VENTOINHA, LOW);

  // Inicializa sensores e display
  dht.begin();
  lcd.init();
  lcd.backlight();

  // Registra ícones customizados no LCD (0 a 3)
  lcd.createChar(0, iconeTermometro);
  lcd.createChar(1, iconeGota);
  lcd.createChar(2, iconeWifi);
  lcd.createChar(3, iconeAlerta);

  // Teste sonoro de inicialização
  tone(PIN_BUZZER, 1800, 200);

  // Animação de inicialização do AgroLink
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(F("AgroLink Estufa"));
  lcd.setCursor(0, 1);
  lcd.print(F("Iniciando..."));
  delay(1500);

  lcd.clear();
  Serial.println(F("[AGROLINK] Sistema Arduino Uno pronto!"));

  // Habilita Watchdog Timer de 8 segundos (proteção contra travamentos)
  wdt_enable(WDTO_8S);
}

// =========================================================================================
// LOOP PRINCIPAL
// =========================================================================================

void loop() {
  // Reinicia o contador do cão de guarda (Watchdog)
  wdt_reset();

  unsigned long tempoAtual = millis();

  // ---------------------------------------------------------------------------------------
  // 1. LEITURA DO BOTÃO FÍSICO MULTIFUNÇÃO (PINO 2)
  // ---------------------------------------------------------------------------------------
  bool botaoPressionado = (digitalRead(PIN_BOTAO) == LOW);

  // Fluxo de Desconexão Ativo (Cronômetro regressivo de 10 segundos)
  if (emFluxoDesconexao) {
    unsigned long decorrido = (tempoAtual - tempoInicioDesconexao) / 1000;
    int restante = 10 - decorrido;

    // Se o usuário pressionar 1 clique rápido durante o cronômetro -> CONFIRMA A DESCONEXÃO!
    if (botaoPressionado && !botaoEstavaPressionado) {
      emFluxoDesconexao = false;
      sistemaOnline = false;
      soarBipeDesconexao();

      // Envia ordem para o ESP-12E encerrar sessão Wi-Fi/MQTT
      espSerial.println(F("{\"cmd\":\"desconectar\"}"));

      exibirMensagemRapida("Desconectado!", "Sessao encerrada");
      return;
    }

    // Atualiza a tela com o cronômetro regressivo
    if (restante != segundosRestantesDesconexao) {
      segundosRestantesDesconexao = restante;
      lcd.clear();
      lcd.setCursor(0, 0);
      lcd.print(F("Desconectar?"));
      lcd.setCursor(0, 1);
      lcd.print(F("Confirme em: "));
      lcd.print(segundosRestantesDesconexao);
      lcd.print(F("s"));
    }

    // Se o tempo esgotar sem confirmação -> CANCELA AUTOMATICAMENTE POR SEGURANÇA
    if (decorrido >= 10) {
      emFluxoDesconexao = false;
      soarBipeCurto();
      exibirMensagemRapida("Cancelado!", "Conexao mantida");
      return;
    }

    botaoEstavaPressionado = botaoPressionado;
    delay(50);
    return; // Mantém foco no cronômetro
  }

  // Detecção de clique longo (3 segundos)
  if (botaoPressionado) {
    if (!botaoEstavaPressionado) {
      tempoInicioPressionado = tempoAtual;
      botaoEstavaPressionado = true;
    } else {
      unsigned long duracaoPressionado = tempoAtual - tempoInicioPressionado;

      // Se segurou por 3 segundos:
      if (duracaoPressionado >= 3000) {
        // CASO A: Se o App já estiver conectado -> Inicia fluxo de proteção contra desconexão
        if (sistemaOnline) {
          emFluxoDesconexao = true;
          tempoInicioDesconexao = millis();
          segundosRestantesDesconexao = 10;
          soarBipeCurto();
          tempoInicioPressionado = tempoAtual + 10000; // Evita reacionar
        } 
        // CASO B: Se desconectado -> Entra no modo de configuração de rede Wi-Fi
        else {
          emModoConfiguracao = true;
          soarBipeModoConfig();
          espSerial.println(F("{\"cmd\":\"modo_config\"}"));
          exibirMensagemRapida("Modo Config", "Rede: AgroLink");
          tempoInicioPressionado = tempoAtual + 10000;
        }
      }
    }
  } else {
    botaoEstavaPressionado = false;
  }

  // ---------------------------------------------------------------------------------------
  // 2. RECEBIMENTO DE DADOS DO ADAPTADOR ESP-12E (VIA SOFTWARE SERIAL)
  // ---------------------------------------------------------------------------------------
  while (espSerial.available() > 0) {
    char c = espSerial.read();
    if (c == '\n' || c == '\r') {
      if (bufferSerial.length() > 0) {
        processarComando(bufferSerial);
        bufferSerial = "";
      }
    } else if (bufferSerial.length() < 96) {
      bufferSerial += c;
    }
  }

  // Também permite comandos pelo Monitor Serial USB do Arduino (para testes)
  while (Serial.available() > 0) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (bufferSerial.length() > 0) {
        processarComando(bufferSerial);
        bufferSerial = "";
      }
    } else if (bufferSerial.length() < 96) {
      bufferSerial += c;
    }
  }

  // ---------------------------------------------------------------------------------------
  // 3. LEITURA DOS SENSORES E CONTROLE AUTOMÁTICO INTELIGENTE
  // ---------------------------------------------------------------------------------------
  if (tempoAtual - ultimoTempoLeitura >= intervaloLeitura) {
    ultimoTempoLeitura = tempoAtual;

    // Leitura DHT11
    float t = dht.readTemperature();
    float h = dht.readHumidity();
    if (!isnan(t)) temperatura = t;
    if (!isnan(h)) umidadeAr = h;

    // Leitura do Sensor de Solo (A0)
    umidadeSoloBruto = analogRead(sensorSoloPin);
    // Mapeia para porcentagem aproximada (calibração flexível)
    // Se o valor bruto for maior que LIMITE_SOLO_MOLHADO_VAL, saturação máxima
    umidadeSoloPorcento = map(umidadeSoloBruto, LIMITE_SOLO_SECO_VAL, LIMITE_SOLO_MOLHADO_VAL, 0, 100);
    umidadeSoloPorcento = constrain(umidadeSoloPorcento, 0, 100);

    // Leitura do Nível de Água (A1)
    nivelAguaBruto = analogRead(sensorAguaPin);
    // Se a leitura for menor que o limite, indica reservatório baixo
    faltaAgua = (nivelAguaBruto < LIMITE_AGUA_BAIXA_VAL);

    // Alerta sonoro intermitente caso o reservatório esteja vazio
    if (faltaAgua) {
      if (tempoAtual - ultimoAlertaAgua >= 4000) {
        ultimoAlertaAgua = tempoAtual;
        soarBipeAlertaAgua();
      }
      // Se a bomba estiver ligada e a água acabar, desliga IMEDIATAMENTE por segurança!
      if (bombaLigada) {
        acionarBomba(false, "TravaSeguranca");
      }
    }

    // --- ROTINA INTELIGENTE: BOMBA DE ÁGUA AUTOMÁTICA ---
    if (autoBomba && !faltaAgua) {
      // Solo seco (< 40% ou leitura bruta < limite): Liga a bomba
      if (umidadeSoloBruto < LIMITE_SOLO_SECO_VAL && !bombaLigada) {
        acionarBomba(true, "AutoSoloSeco");
      }
      // Ponto ideal atingido (>= 75% ou leitura bruta adequada): Desliga para evitar encharcar
      else if (umidadeSoloBruto >= (LIMITE_SOLO_SECO_VAL + 250) && bombaLigada) {
        acionarBomba(false, "AutoSoloIdeal");
      }
    }

    // --- ROTINA INTELIGENTE: VENTOINHA AUTOMÁTICA ---
    if (autoVentoinha) {
      // Temperatura elevada (> 30°C): Liga a ventoinha
      if (temperatura > TEMP_IDEAL_MAX && !ventoinhaLigada) {
        acionarVentoinha(true, "AutoTempAlta");
      }
      // Temperatura amenizou (<= 27°C): Desliga a ventoinha
      else if (temperatura <= TEMP_IDEAL_MIN && ventoinhaLigada) {
        acionarVentoinha(false, "AutoTempNormal");
      }
    }
  }

  // ---------------------------------------------------------------------------------------
  // 4. ENVIO PERIÓDICO DE TELEMETRIA PARA O ESP-12E / APP
  // ---------------------------------------------------------------------------------------
  if (tempoAtual - ultimoTempoTelemetria >= intervaloTelemetria) {
    ultimoTempoTelemetria = tempoAtual;
    enviarTelemetria();
  }

  // ---------------------------------------------------------------------------------------
  // 5. ATUALIZAÇÃO DO DISPLAY LCD 16x2
  // ---------------------------------------------------------------------------------------
  if (tempoAtual - ultimoTempoLCD >= tempoExibicaoTela) {
    ultimoTempoLCD = tempoAtual;
    telaAtual = (telaAtual == 1) ? 2 : 1;
    lcd.clear();
  }

  // Se estiver em modo de configuração de rede:
  if (emModoConfiguracao) {
    lcd.setCursor(0, 0);
    lcd.write(byte(2)); // Ícone Wi-Fi
    lcd.print(F(" Config. Wi-Fi"));
    lcd.setCursor(0, 1);
    lcd.print(F("Abra o AgroLink!"));
    return;
  }

  // --- TELA 1: Ambiente & Clima (Temperatura e Umidade do Ar) ---
  if (telaAtual == 1) {
    lcd.setCursor(0, 0);
    lcd.print(F("Clima Estufa:"));
    lcd.setCursor(14, 0);
    if (sistemaOnline) {
      lcd.write(byte(2)); // Ícone Wi-Fi online
      lcd.print(F(" "));
    } else {
      lcd.print(F("--"));
    }

    lcd.setCursor(0, 1);
    lcd.write(byte(0)); // Termômetro
    lcd.print((int)temperatura);
    lcd.print(F("C "));

    lcd.print(F("Ar:"));
    lcd.print((int)umidadeAr);
    lcd.print(F("% "));

    lcd.setCursor(12, 1);
    lcd.print(ventoinhaLigada ? F("V:ON") : F("V:OF"));
  }
  // --- TELA 2: Solo & Reservatório de Água ---
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
      lcd.print(F(" SEM AGUA NO RES"));
    } else {
      lcd.print(F("Res. Agua: NORMAL"));
    }
  }
}
