# 🌱 AgroLink - Gestão Inteligente de Estufas Automatizadas

![Logo AgroLink](assets/logo.png)

> **AgroLink** é uma plataforma completa e moderna de monitoramento agronômico e controle inteligente de estufas automatizadas em tempo real. O ecossistema conecta microcontroladores **Arduino Uno** e adaptadores sem fio **ESP-12E (Wi-Fi)** a um aplicativo **Android nativo/APK** com suporte a **múltiplas estufas** (estilo Smart Life), interface com gráficos históricos, trava de segurança de reservatório e automação baseada em parâmetros ideais da horticultura.

---

## 📌 Arquitetura do Sistema

```
                      ┌────────────────────────────────────────┐
                      │    APLICATIVO ANDROID "AGROLINK"       │
                      │  (Multi-Estufas / Gráficos / APK)      │
                      └──────────────────┬─────────────────────┘
                                         │ WSS / MQTTS (Porta 8084 / 8883)
                                         ▼
                      ┌────────────────────────────────────────┐
                      │    SERVIDOR MQTT SEGURO (EMQX CLOUD)   │
                      │   yfd21101.ala.us-east-1.emqxsl.com    │
                      └──────────────────┬─────────────────────┘
                                         │ MQTTS TLS/SSL (Porta 8883)
                                         ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ UNIDADE DA ESTUFA (HARDWARE INTEGRADO)                                       │
│                                                                              │
│   ┌──────────────────────┐  UART Serial   ┌──────────────────────────────┐   │
│   │ ADAPTADOR WI-FI      ├───────────────►│ ARDUINO UNO + WATCHDOG       │   │
│   │ ESP-12E (ESP8266)    │◄───────────────┤ (Controle, Sensores & Trava) │   │
│   └──────────────────────┘   (Pinos 8 e 9)└──────┬───────┬───────┬───────┘   │
│                                                  │       │       │           │
│                                 ┌────────────────┘       │       └──────┐    │
│                                 ▼                        ▼              ▼    │
│                        ┌─────────────────┐      ┌─────────────┐  ┌─────────┐ │
│                        │ TELINHA LCD     │      │ ATUADORES   │  │ SENSORES│ │
│                        │ 16x2 I2C (0x27) │      │ - Bomba(D10)│  │ - Ar D6 │ │
│                        │ Status / Alertas│      │ - Vento D13 │  │ - SoloA0│ │
│                        │ & Desconexão 10s│      │ - Buzzer D11│  │ - AguaA1│ │
│                        └─────────────────┘      └─────────────┘  └─────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 🔌 Pinagem e Mapeamento de Hardware (Arduino Uno)

| Componente | Tipo | Pino no Arduino | Descrição / Função |
| :--- | :--- | :--- | :--- |
| **DHT11** | Digital | **Pino 6** | Mede Temperatura do Ar e Umidade Relativa |
| **Higrômetro do Solo** | Analógico | **Pino A0** | Mede a umidade da terra (0% a 100%) |
| **Nível de Água (Reservatório)** | Analógico | **Pino A1** | Mede o volume de água restante no tanque |
| **Bomba d'Água (Irrigação)** | Digital (Relé) | **Pino 10** | Aciona a mangueira / gotejamento |
| **Alarme Sonoro (Buzzer)** | Digital | **Pino 11** | Bipes de confirmação, conexão e alerta crítico |
| **Ventoinha (Cooler)** | Digital (Relé) | **Pino 13** | Exaustão / circulação de ar |
| **Botão Físico Multifunção** | Digital (Input) | **Pino 2** | Modo Config (3s) e Desconexão segura (10s) |
| **Adaptador Wi-Fi ESP-12E** | Serial RX/TX | **Pinos 8 (RX) e 9 (TX)** | Envia telemetria e recebe comandos MQTT |
| **Display LCD 16x2 I2C** | I2C (SDA/SCL) | **Pinos A4 (SDA) e A5 (SCL)** | Telinha de informações e menus |

---

## 🎵 Padrões Sonoros do Alarme (Buzzer - Pino 11)

- **1 Bipe curto:** Confirmação de toque no botão ou recebimento de comando pelo aplicativo.
- **2 Bipes rápidos:** Conexão sem fio Wi-Fi / MQTT estabelecida com sucesso.
- **Bipe intermitente:** Alerta crítico de nível de água baixo no reservatório.
- **Bipe longo:** Entrada no modo de configuração sem fio (quando o botão é segurado por 3s).
- **Bipe duplo grave:** Desconexão manual confirmada.

---

## 🔒 Fluxo de Desconexão Segura no Botão Físico

Para evitar desconexões acidentais na estufa enquanto o aplicativo estiver conectado:
1. Se o usuário segurar o botão físico por **3 segundos**, o display LCD exibirá:
   ```
   Desconectar?
   Confirme em: 10s
   ```
2. Se o usuário **deixar os 10 segundos terminarem sozinhos**, o pedido é cancelado por segurança e a telinha volta ao monitoramento normal.
3. Se o usuário **apertar 1 vez o botão físico durante o cronômetro**, a desconexão é confirmada, o sistema encerra a sessão sem fio e o aplicativo atualiza o status para **Offline**.

---

## 🌐 Credenciais e Tópicos MQTT Isolados por Estufa

- **Servidor Broker:** `yfd21101.ala.us-east-1.emqxsl.com`
- **Porta MQTTS (TLS/SSL):** `8883`
- **Porta WSS (WebSockets Seguro):** `8084`
- **Usuário:** `agro_user`
- **Senha:** `thiago6767`

### Estrutura de Tópicos por Estufa
Cada unidade possui tópicos isolados pelo seu ID (ex: `estufa_01`, `estufa_02`):
- **Telemetria:** `agrolink/{id_estufa}/telemetria`
- **Comandos:** `agrolink/{id_estufa}/comando`
- **Confirmações (ACK):** `agrolink/{id_estufa}/ack`
- **Status Online/Offline:** `agrolink/{id_estufa}/status`

---

## 📱 Como Gerar o Instalador Android (.APK)

### Opção 1: Via Android Studio (Recomendado)
1. Abra o **Android Studio**.
2. Clique em **Open** e selecione a pasta `android` localizada dentro deste projeto.
3. Aguarde o Gradle sincronizar os arquivos.
4. No menu superior, vá em **Build** > **Build Bundle(s) / APK(s)** > **Build APK(s)**.
5. O arquivo `AgroLink.apk` será gerado em:
   `android/app/build/outputs/apk/debug/app-debug.apk`
6. Transfira para o celular e instale diretamente!

### Opção 2: PWA Direto no Celular
1. Abra o link do projeto pelo Google Chrome no celular:
   `https://tulio713645.github.io/smart-estufa-web-app/`
2. Toque no menu do navegador (3 pontinhos) e clique em **"Instalar aplicativo"** ou **"Adicionar à tela inicial"**.
3. O ícone oficial do **AgroLink** será instalado como um app independente!

---

## 🛡️ Parâmetros Agronômicos Reais Integrados

- **Temperatura do Ar:** Faixa ideal de **20°C a 30°C**. A ventoinha é ativada automaticamente acima de 30°C e desliga ao resfriar abaixo de 27°C.
- **Umidade Relativa do Ar:** Faixa ideal de **60% a 80%**. Evita ar seco e proliferação de fungos.
- **Umidade do Solo:** Faixa ideal de **60% a 80% da capacidade de campo**. A irrigação é ativada quando o solo está seco (<40%) e desliga automaticamente ao atingir 75%-80%, evitando encharcamento e apodrecimento radicular.
- **Trava do Reservatório:** Se o sensor detectar nível crítico de água, a bomba é bloqueada rigidamente, impedindo que o motor queime a seco.
