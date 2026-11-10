# 🌱 Estufa Inteligente - Monitoramento & Controle via Bluetooth

Aplicação Web moderna, *mobile-first*, com visual *dark mode* elegante para monitoramento e controle da estufa inteligente através de **Bluetooth (HC-05 / HC-06 / HM-10)** diretamente pelo navegador Google Chrome (sem precisar instalar nenhum aplicativo da Play Store!).

---

## 🏗️ Arquitetura do Sistema (Arduino Uno + Bluetooth)

```text
[Sensores & Relés]
        │
        ▼
 [Arduino Uno] (DHT11 pino 6, Relé pino 10, Solo A0, LCD 16x2 I2C 0x27)
        │
        │ Serial 9600 baud (Pinos 2 e 3 SoftwareSerial / Pinos 0 e 1 Serial USB)
        ▼
 [Módulo Bluetooth (HC-05 / HC-06 / HM-10)]
        ▲
        │ Conexão Bluetooth sem fio (Alcance ~10-15 metros)
        │
 [App Web SPA no Celular / PC (Google Chrome)]
  (Conexão direta pelo botão "Conectar Bluetooth")
```

---

## 🔌 Esquema de Ligação dos Pinos no Arduino Uno

### 1. Arduino Uno ➔ Módulo Bluetooth
| Pino Arduino Uno | Pino Módulo Bluetooth | Observação |
| :--- | :--- | :--- |
| **5V** | **VCC** | Alimentação do módulo |
| **GND** | **GND** | Terra Comum |
| **Pino Digital 2 (RX)** | **TX** | O Arduino recebe os comandos enviados pelo celular |
| **Pino Digital 3 (TX)** | **RX** | O Arduino envia as leituras de telemetria |

*(Dica: Se preferir ligar diretamente nos pinos 0 e 1 do Arduino, o código também envia e recebe na porta Serial nativa ao mesmo tempo!).*

### 2. Arduino Uno ➔ Display LCD 16x2 (I2C)
| Pino Arduino Uno | Pino LCD I2C | Descrição |
| :--- | :--- | :--- |
| **5V** | **VCC** | Alimentação |
| **GND** | **GND** | Terra |
| **Pino Analógico A4** | **SDA** | Dados I2C |
| **Pino Analógico A5** | **SCL** | Clock I2C |

### 3. Arduino Uno ➔ Sensores & Relés (Pinos do seu Projeto)
| Componente | Pino Arduino Uno | Descrição |
| :--- | :--- | :--- |
| **Sensor DHT11** | `Pino Digital 6` | Temperatura do Ar (°C) e Umidade do Ar (%) |
| **Relé da Bomba de Água** | `Pino Digital 10` | Acionamento da bomba (Active-Low: LOW liga) |
| **Higrômetro de Solo** | `Pino Analógico A0` | Leitura analógica da umidade do solo |
| **Sensor Boia de Nível (Amanhã)** | `Pino Digital 7` | Entrada com pull-up para nível do reservatório |
| **Relé da Ventoinha (Amanhã)** | `Pino Digital 8` | Controle do cooler térmico |

---

## 📱 Como Conectar no Aplicativo Web

1. Abra o site no navegador Google Chrome do seu celular Android ou PC:  
   👉 **[tulio713645.github.io/smart-estufa-web-app](https://tulio713645.github.io/smart-estufa-web-app/)**
2. Ligue a sua estufa na tomada.
3. No topo da página, clique no botão azul **"🔵 Conectar Bluetooth"**.
4. O navegador abrirá a lista de dispositivos Bluetooth por perto.
5. Selecione o seu módulo Bluetooth (ex: `HC-05`, `HC-06`, `BT-05`, `Estufa`, etc.) e toque em **Parear/Conectar**.
6. Pronto! A página passará a exibir as leituras de temperatura, umidade do solo e do ar em tempo real e você poderá ligar e desligar a bomba pelo celular!

---

## 📂 Arquivos do Repositório

```text
Interface Estufa/
├── index.html           # SPA moderna com suporte nativo a Bluetooth
├── style.css            # Estilos dark mode com cards e animações
├── app.js               # Conexão Web Bluetooth / Web Serial e parser JSON
├── estufa_hardware.ino  # Código completo do Arduino Uno adaptado com Bluetooth
└── README.md            # Documentação e esquema de ligação
```
