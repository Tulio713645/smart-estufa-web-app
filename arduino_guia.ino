/*
 * =========================================================================================
 * ESTUFA INTELIGENTE - CÓDIGO DE EXEMPLO PARA ARDUINO / ESP32 / ESP8266
 * =========================================================================================
 * 
 * Este sketch implementa o servidor HTTP REST que alimenta a aplicação Web SPA.
 * Ele lê os sensores, controla os relés de atuadores e responde requisições em formato JSON
 * com os devidos cabeçalhos CORS (Cross-Origin Resource Sharing) habilitados.
 *
 * BIBLIOTECAS NECESSÁRIAS (Instalar pelo Gerenciador de Bibliotecas da Arduino IDE):
 *  1. "DHT sensor library" por Adafruit
 *  2. "Adafruit Unified Sensor" por Adafruit
 *
 * COMPATIBILIDADE:
 *  - ESP32 (NodeMCU-32S, ESP32 Dev Module, etc.)
 *  - ESP8266 (NodeMCU v2/v3, Wemos D1 Mini, etc.)
 *
 * ENDPOINTS HTTP IMPLEMENTADOS:
 *  - GET  /dados             -> Retorna o JSON com todos os sensores e estados atuais
 *  - POST /bomba/toggle      -> Alterna o estado da bomba (LIGA/DESLIGA)
 *  - GET  /bomba/toggle      -> Alterna o estado da bomba (suporte a GET alternativo)
 *  - POST /ventoinha/toggle  -> Alterna o estado da ventoinha (LIGA/DESLIGA)
 *  - GET  /ventoinha/toggle  -> Alterna o estado da ventoinha (suporte a GET alternativo)
 *  - OPTIONS /*              -> Pré-flight CORS para navegadores modernos
 * =========================================================================================
 */

#if defined(ESP32)
  #include <WiFi.h>
  #include <WebServer.h>
  WebServer server(80);
#elif defined(ESP8266)
  #include <ESP8266WiFi.h>
  #include <ESP8266WebServer.h>
  ESP8266WebServer server(80);
#else
  #error "Este código foi projetado para ESP32 ou ESP8266 (com suporte a Wi-Fi nativo)."
#endif

#include <DHT.h>

// =========================================================================================
// 1. CONFIGURAÇÃO DA REDE WI-FI
// =========================================================================================
// Substitua com o nome e a senha da sua rede Wi-Fi:
const char* WIFI_SSID = "SUA_REDE_WIFI";
const char* WIFI_PASS = "SUA_SENHA_WIFI";

// DICA: Se preferir que a estufa crie sua própria rede Wi-Fi (Modo Ponto de Acesso / AP):
// Ative a linha abaixo mudando para 'true'. O IP padrão será 192.168.4.1!
const bool MODO_ACCESS_POINT = false;
const char* AP_SSID = "Estufa-Inteligente";
const char* AP_PASS = "12345678";

// =========================================================================================
// 2. DEFINIÇÃO DE PINOS DOS SENSORES E ATUADORES
// =========================================================================================
#if defined(ESP32)
  #define PINO_DHT         4      // GPIO 4 -> Sensor DHT11 (Dados)
  #define PINO_SOLO_ADC    34     // GPIO 34 (ADC1_CH6) -> Higrômetro do Solo Analógico
  #define PINO_BOIA_AGUA   18     // GPIO 18 -> Sensor de Nível de Água (Boia)
  #define PINO_RELE_BOMBA  26     // GPIO 26 -> Relé da Bomba de Irrigação
  #define PINO_RELE_VENT   27     // GPIO 27 -> Relé da Ventoinha / Cooler
#elif defined(ESP8266)
  #define PINO_DHT         D4     // GPIO 2  -> Sensor DHT11
  #define PINO_SOLO_ADC    A0     // ADC 0   -> Higrômetro do Solo Analógico (0 a 1023)
  #define PINO_BOIA_AGUA   D7     // GPIO 13 -> Sensor de Nível de Água (Boia)
  #define PINO_RELE_BOMBA  D1     // GPIO 5  -> Relé da Bomba de Irrigação
  #define PINO_RELE_VENT   D2     // GPIO 4  -> Relé da Ventoinha / Cooler
#endif

#define TIPO_DHT DHT11
DHT dht(PINO_DHT, TIPO_DHT);

// Lógica de acionamento do módulo de relé:
// A maioria dos módulos de relé para Arduino aciona em nível LÓGICO BAIXO (LOW = Ligado, HIGH = Desligado).
// Se o seu módulo acionar com HIGH, inverta os valores de RELE_LIGADO e RELE_DESLIGADO abaixo:
const int RELE_LIGADO    = LOW;
const int RELE_DESLIGADO = HIGH;

// =========================================================================================
// 3. VARIÁVEIS DE ESTADO
// =========================================================================================
bool estadoBomba = false;
bool estadoVentoinha = false;

// Calibração do Sensor de Solo (Ajuste conforme os testes com solo seco e úmido)
// No solo 100% seco a leitura costuma ser maior; na água pura a leitura é menor.
#if defined(ESP32)
  const int SOLO_VALOR_SECO = 3200;   // Leitura com o sensor no ar/seco (ESP32 ADC 12 bits 0-4095)
  const int SOLO_VALOR_UMIDO = 1400;  // Leitura com o sensor na terra molhada
#else
  const int SOLO_VALOR_SECO = 850;    // Leitura ESP8266 (ADC 10 bits 0-1023)
  const int SOLO_VALOR_UMIDO = 350;
#endif

// =========================================================================================
// 4. FUNÇÕES DE SUPORTE E LEITURA DE SENSORES
// =========================================================================================

// Habilita cabeçalhos CORS para permitir que navegadores em outras origens acessem a API
void aplicarCabecalhosCORS() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
}

// Resposta a requisições de preflight OPTIONS do navegador
void handleOptions() {
  aplicarCabecalhosCORS();
  server.send(204);
}

// Lê a porcentagem de umidade do solo convertendo o valor analógico
int lerUmidadeSoloPercentual() {
  int leituraADC = analogRead(PINO_SOLO_ADC);
  
  // Limita os valores entre os extremos calibrados
  int leituraClamped = constrain(leituraADC, SOLO_VALOR_UMIDO, SOLO_VALOR_SECO);
  
  // Mapeia para porcentagem: solo úmido = 100%, solo seco = 0%
  int porcentagem = map(leituraClamped, SOLO_VALOR_SECO, SOLO_VALOR_UMIDO, 0, 100);
  return constrain(porcentagem, 0, 100);
}

// Monta a string JSON no formato exato esperado pela interface Web
String gerarJsonEstufa() {
  // Leitura de temperatura e umidade com DHT
  float temp = dht.readTemperature();
  float humAr = dht.readHumidity();

  // Tratamento contra falhas de leitura do DHT
  if (isnan(temp)) temp = 25.0;
  if (isnan(humAr)) humAr = 55.0;

  // Umidade do Solo
  int humSolo = lerUmidadeSoloPercentual();

  // Nível da Água: se sensor de boia estiver usando pull-up, LOW geralmente indica água suficiente
  int leituraBoia = digitalRead(PINO_BOIA_AGUA);
  // Se a boia fechar com água (LOW): "OK", caso contrário: "CRITICO"
  String nivelAgua = (leituraBoia == LOW) ? "OK" : "CRITICO";

  // Montagem do payload JSON
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

// =========================================================================================
// 5. ROTAS DA API HTTP
// =========================================================================================

// GET /dados
void handleGetDados() {
  aplicarCabecalhosCORS();
  String resposta = gerarJsonEstufa();
  server.send(200, "application/json; charset=utf-8", resposta);
}

// Alternar estado da Bomba (/bomba/toggle)
void handleToggleBomba() {
  aplicarCabecalhosCORS();
  estadoBomba = !estadoBomba;
  digitalWrite(PINO_RELE_BOMBA, estadoBomba ? RELE_LIGADO : RELE_DESLIGADO);
  
  Serial.print("[ATUADOR] Bomba de Água: ");
  Serial.println(estadoBomba ? "LIGADA" : "DESLIGADA");

  // Retorna o estado atualizado em JSON
  String resposta = gerarJsonEstufa();
  server.send(200, "application/json; charset=utf-8", resposta);
}

// Alternar estado da Ventoinha (/ventoinha/toggle)
void handleToggleVentoinha() {
  aplicarCabecalhosCORS();
  estadoVentoinha = !estadoVentoinha;
  digitalWrite(PINO_RELE_VENT, estadoVentoinha ? RELE_LIGADO : RELE_DESLIGADO);
  
  Serial.print("[ATUADOR] Ventoinha: ");
  Serial.println(estadoVentoinha ? "LIGADA" : "DESLIGADA");

  // Retorna o estado atualizado em JSON
  String resposta = gerarJsonEstufa();
  server.send(200, "application/json; charset=utf-8", resposta);
}

// Rota 404 (Não encontrada)
void handleNotFound() {
  aplicarCabecalhosCORS();
  if (server.method() == HTTP_OPTIONS) {
    server.send(204);
    return;
  }
  server.send(404, "application/json", "{\"erro\":\"Rota não encontrada\"}");
}

// =========================================================================================
// 6. SETUP E LOOP PRINCIPAL
// =========================================================================================
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n--- INICIALIZANDO ESTUFA INTELIGENTE ---");

  // Configuração dos Pinos dos Relés
  pinMode(PINO_RELE_BOMBA, OUTPUT);
  pinMode(PINO_RELE_VENT, OUTPUT);
  digitalWrite(PINO_RELE_BOMBA, RELE_DESLIGADO);
  digitalWrite(PINO_RELE_VENT, RELE_DESLIGADO);

  // Configuração do Sensor de Boia (com resistor de pull-up interno)
  pinMode(PINO_BOIA_AGUA, INPUT_PULLUP);

  // Inicializa o Sensor DHT11
  dht.begin();

  // Conexão Wi-Fi
  if (MODO_ACCESS_POINT) {
    Serial.println("[WIFI] Criando Ponto de Acesso (Access Point)...");
    WiFi.mode(WIFI_AP);
    WiFi.softAP(AP_SSID, AP_PASS);
    Serial.print("[WIFI] SSID do AP: ");
    Serial.println(AP_SSID);
    Serial.print("[WIFI] Endereço IP do AP: ");
    Serial.println(WiFi.softAPIP());
  } else {
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
      Serial.print("[WIFI] Endereço IP: ");
      Serial.println(WiFi.localIP());
      Serial.println(">>> Digite este IP no painel da Aplicação Web SPA <<<");
    } else {
      Serial.println("\n[WIFI] Falha ao conectar na rede Wi-Fi configurada.");
      Serial.println("[WIFI] Verifique o SSID e a Senha no código.");
    }
  }

  // Configuração das Rotas do WebServer
  server.on("/dados", HTTP_GET, handleGetDados);
  server.on("/dados", HTTP_OPTIONS, handleOptions);

  server.on("/bomba/toggle", HTTP_POST, handleToggleBomba);
  server.on("/bomba/toggle", HTTP_GET, handleToggleBomba);
  server.on("/bomba/toggle", HTTP_OPTIONS, handleOptions);

  server.on("/ventoinha/toggle", HTTP_POST, handleToggleVentoinha);
  server.on("/ventoinha/toggle", HTTP_GET, handleToggleVentoinha);
  server.on("/ventoinha/toggle", HTTP_OPTIONS, handleOptions);

  server.onNotFound(handleNotFound);

  // Inicia o servidor HTTP na porta 80
  server.begin();
  Serial.println("[HTTP] Servidor Web ativo e pronto para requisições!");
}

void loop() {
  // Atende as conexões de clientes Web
  server.handleClient();
}
