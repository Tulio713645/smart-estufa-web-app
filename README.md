# 🌱 Estufa Inteligente - Single Page Application (SPA)

Aplicação Web moderna, mobile-first, com design dark mode elegante para monitoramento de sensores em tempo real e controle de atuadores de uma estufa inteligente baseada em microcontroladores **ESP32** ou **ESP8266 / Arduino**.

---

## 📱 Recursos Principais da Interface

1. **Mobile-First & Dark Mode Elegante**:
   - Layout fluido otimizado para celulares e adaptável a telas maiores.
   - Paleta escura suave de alto contraste com efeito glassmorphism e iluminação sutil.
   - Ícones vetoriais inline integrados (100% autossuficiente e funciona até sem conexão com a internet).

2. **Cabeçalho Fixo com Status em Tempo Real**:
   - Indicador visual dinâmico com animação de pulso:
     - 🟢 **Conectado** (comunicação ativa com o microcontrolador).
     - 🔴 **Desconectado** (indica perda de sinal ou host inacessível).
     - 🟡 **Simulado** (Modo Demonstração ativo).
   - Botão de engrenagem para abrir o **Modal de Configurações**.
   - Botão de recarregamento rápido instantâneo.

3. **Cards de Sensores**:
   - 🌡️ **Temperatura do Ar (°C)**: Leitura do sensor DHT11 com indicação de faixas de conforto.
   - 💧 **Umidade do Ar (%)**: Leitura do DHT11 com alertas de ar seco ou saturado.
   - 🌿 **Umidade do Solo (%)**: Higrômetro analógico com **Barra de Progresso Dinâmica** (Seco < 30% em vermelho, Ideal 30-70% em esmeralda, Saturado > 70% em azul).
   - 🚰 **Nível de Água do Reservatório**: Boia/sensor de nível com alerta visual pulsante de nível crítico e representação visual gráfica do reservatório.

4. **Painel de Atuadores (Controles Manuais)**:
   - 🚿 **Bomba de Água (Irrigação)**: Botão switch tipo iOS com alerta de segurança se o nível de água estiver crítico (evitando queimar a bomba seca).
   - 🌀 **Ventoinha (Cooler)**: Botão switch com **animação de rotação contínua e suave** do ícone da hélice quando ligada.
   - Contador de atuadores ativos em tempo real.

5. **Modal de Configurações & Persistência Local**:
   - Campo para digitar o **Endereço IP** ou nome mDNS (ex: `192.168.1.150` ou `estufa.local`).
   - Salvo automaticamente no `localStorage` do navegador.
   - Frequência de polling ajustável (1.5s, 2.5s, 4s, 6s).
   - Botão **"Testar Conexão Agora"** para diagnóstico instantâneo.
   - **Modo Demonstração (Simulado)**: Permite testar todos os botões, animações e gráficos localmente sem necessidade do hardware físico ligado.

---

## 📂 Estrutura de Arquivos

```text
Interface Estufa/
├── index.html        # Estrutura semântica HTML5 da SPA e modais
├── style.css         # Folha de estilos moderna dark mode, animações e responsividade
├── app.js            # Lógica da aplicação, polling periódico, fetch e localStorage
├── arduino_guia.ino  # Código C++ para ESP32 e ESP8266 com WebServer REST e CORS
└── README.md         # Documentação completa de uso e montagem
```

---

## 🚀 Como Executar a Aplicação Web

Como o projeto foi desenvolvido em **HTML5, CSS3 e JavaScript moderno puro**, ele **não requer Node.js nem compilação prévia**:

1. **Abrir diretamente**:
   - Dê um duplo clique no arquivo [`index.html`](file:///c:/Users/tulio/Documents/Túlio/Interface%20Estufa/index.html) para abrir no seu navegador preferido (Chrome, Edge, Firefox, Safari).
2. **No Celular**:
   - Para abrir no celular, você pode compartilhar a pasta via rede local, usar a extensão **Live Server** do VS Code, ou colocar os arquivos `index.html`, `style.css` e `app.js` em qualquer servidor web estático (GitHub Pages, Netlify, etc.) ou até mesmo servir diretamente da memória flash SPIFFS/LittleFS do ESP!

---

## 🔌 Integração com o Arduino / ESP (`arduino_guia.ino`)

O arquivo [`arduino_guia.ino`](file:///c:/Users/tulio/Documents/Túlio/Interface%20Estufa/arduino_guia.ino) já está pronto para uso e suporta tanto **ESP32** quanto **ESP8266**.

### 1. Esquema de Pinos Recomendado

| Componente | Pino no ESP32 | Pino no ESP8266 (NodeMCU) |
| :--- | :--- | :--- |
| **Sensor DHT11 (Dados)** | `GPIO 4` | `D4` (`GPIO 2`) |
| **Higrômetro de Solo (Analógico)** | `GPIO 34` | `A0` |
| **Sensor de Nível / Boia (Digital)** | `GPIO 18` | `D7` (`GPIO 13`) |
| **Relé 1 - Bomba de Água** | `GPIO 26` | `D1` (`GPIO 5`) |
| **Relé 2 - Ventoinha / Cooler** | `GPIO 27` | `D2` (`GPIO 4`) |

### 2. Formato da API REST

A aplicação se comunica através dos seguintes endpoints:

#### `GET /dados`
Retorna as leituras e o estado dos relés:
```json
{
  "temp": 25.5,
  "umidade_ar": 60,
  "umidade_solo": 45,
  "nivel_agua": "OK",
  "bomba": 0,
  "ventoinha": 0
}
```

#### `POST /bomba/toggle` (ou `GET /bomba/toggle`)
Inverte o estado do relé da bomba e retorna o JSON atualizado.

#### `POST /ventoinha/toggle` (ou `GET /ventoinha/toggle`)
Inverte o estado do relé da ventoinha e retorna o JSON atualizado.

### 3. Cabeçalhos CORS
O código C++ no microcontrolador inclui os cabeçalhos:
```cpp
server.sendHeader("Access-Control-Allow-Origin", "*");
server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
server.sendHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
```
Isso garante que o navegador permita a comunicação sem bloqueios de segurança entre origens diferentes.

---

## 🧪 Como Testar Imediatamente (Sem Placa Conectada)

1. Abra o arquivo `index.html` no seu navegador.
2. Clique no ícone de **engrenagem (⚙️)** no topo direito.
3. Ative o interruptor **"Modo Demonstração (Simulado)"** e clique em **Salvar Alterações**.
4. O status mudará para verde ("SIMULADO") e você poderá testar:
   - As variações em tempo real de temperatura e umidade.
   - O funcionamento dos toggles da **Bomba** e da **Ventoinha**.
   - A rotação animada do cooler.
   - A barra de progresso da umidade do solo reagindo à irrigação!
