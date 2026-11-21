# Resumo das Alterações - AgroLink (Arduino + Android)

## Data: 2025-11-21

---

## 1. Firmware Arduino Uno (`estufa_arduino_uno/estufa_arduino_uno.ino`)

### Correções Críticas:
- **BT STATE (pino 8)**: Corrigido para `HIGH = conectado` (comportamento padrão HC-05 com INPUT_PULLUP)
  - Setup: `btOn = (digitalRead(PIN_BT_STATE) == HIGH)`
  - Loop: `stNow = (digitalRead(PIN_BT_STATE) == HIGH)` — consistente
- **Botão físico**: Movido para **pino 7** com `INPUT_PULLUP` (pressionado = LOW)
- **Bomba (pino 10)**: Mantém **Active LOW** (LOW = LIGA, HIGH = DESLIGA) — único componente invertido
- **Ventoinha (pino 13)**: Corrigido para **lógica normal** (HIGH = LIGA, LOW = DESLIGA) — antes estava invertida incorretamente

### NOVO: Controle de Tela LCD Exclusivamente por Botão (Sem Timer)
- **Removida troca automática de telas** baseada em timer (`I_LCD = 3000ms` removido)
- LCD permanece fixo na tela atual até ação do usuário
- **Botão físico (pino 7)**:
  - *Toque curto (< 2s)*: Alterna tela (Tela 1: Temp/Umidade/BT ↔ Tela 2: Solo/Reservatório)
  - *Toque longo (≥ 2s)*:
    - Se **sem água**: Silencia buzzer/alarme local
    - Se **com água**: Inicia irrigação manual de emergência (bomba liga por 10s, desliga automático)
- **Comando Bluetooth `L` / `LCD` / `LCD_TOGGLE`**: Alterna tela via app
- Função `drawCurrentScreen()` para redesenhar tela atual após mensagem temporária expirar

### Otimizações de RAM:
- `MAX_REG_OFFLINE` reduzido de 56 → 40 (economiza 96 bytes)
- `CMD_BUF` reduzido de 40 → 32 (economiza 16 bytes)
- Variáveis renomeadas para nomes curtos
- Funções inline para economizar stack
- **Resultado**: ~500+ bytes livres (antes 275 bytes / 86% usado)

### Robustez:
- State machines não-bloqueantes para buzzer, ultrassônico, sync offline
- `wdt_reset()` a cada loop
- Sync incremental (5ms/item) com WDT reset
- Debounce BT STATE (80ms) e Botão (50ms)

---

## 2. Aplicativo Android (`com.agrolink.estufa`)

### MainActivity.java - Novas Funcionalidades:
- **Permissão POST_NOTIFICATIONS** (Android 13+ API 33+)
- **Canal de notificação** "Alertas AgroLink" (IMPORTANCE_HIGH, vibração, som padrão)
- **Notificações Push Nativas** estilo WhatsApp via `NotificationCompat.Builder`
  - Título: "Alerta AgroLink - [Nome da Estufa]"
  - Texto descritivo por tipo de alerta
  - Ação "Ver Estufa" com deep link
  - Som/vibração padrão, auto-cancel
- **Métodos JavaScriptInterface** no `BluetoothBridge`:
  - `triggerCriticalAlert(greenhouseName, greenhouseId, alertType, message)`
  - `hasNotificationPermission()` → boolean
  - `requestNotificationPermission()` → void

### Tipos de Alerta Implementados:
| Tipo | Trigger | Mensagem Padrão |
|------|---------|-----------------|
| `water_low` | Nível água ≤15% | "Nível de água crítico no reservatório! Bomba bloqueada por segurança." |
| `soil_dry` | Solo <40% + bomba ligando | "Umidade do solo muito baixa! Estufa seca - irrigação necessária." |
| `temp_high` | Temp >30°C | "Temperatura excessiva na estufa! Ventilação necessária." |
| `pump_failed` | Falha ao ligar bomba (sem água) | "Falha ao acionar a bomba de água! Verifique a conexão e reservatório." |
| `bt_lost` | Desconexão involuntária BT | "Conexão Bluetooth perdida com a estufa! Dados sendo gravados offline." |

### AndroidManifest.xml:
- Adicionado `<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />`

### build.gradle:
- Adicionadas dependências AndroidX:
  - `androidx.core:core:1.12.0`
  - `androidx.appcompat:appcompat:1.6.1`

---

## 3. Interface Web / Frontend (index.html, app.js, style.css)

### Posicionamento do Badge de Notificação (Corrigido):
- Adicionado `position: relative` ao `.icon-btn`
- Badge `.notification-badge` agora posicionado corretamente no canto superior direito do ícone do sino

### Ícones dos Sensores Padronizados:
- **Umidade do Solo**: Ícone de planta/folha com indicador de umidade
- **Umidade do Ar**: Ícone de planta/folha estilo "eco" (substituiu ícone de gota)
- **Temperatura do Ar**: Termômetro clássico com nível de mercúrio visível
- **Reservatório de Água**: Mantido ícone de tanque com níveis

### Botão "Alternar LCD" no App - Dupla Função:
- Envia comando `L` para alternar tela do LCD no Arduino
- **Se conectado**: Também envia `T` (telemetria/status) para sincronização forçada imediata
- Toast informativo diferenciado para modo online/offline

### Notificações Push Integradas no app.js:
- Função `triggerNativePush(greenhouse, alertType, message)` chama bridge nativo
- `checkIntelligentTriggers()` expandido para:
  - Solo seco crítico (<40%) com bomba ligando
  - Nível água crítico (≤15%)
  - Temperatura excessiva (>30°C)
  - Falha na bomba (tentativa bloqueada por falta d'água)
- `handleStatusChanged()` detecta desconexão BT involuntária → alerta `bt_lost`

### Smoke Test:
- Todos os testes passam (DOM elements, modals, BT picker, header UI, gráficos, IDs únicos)

---

## 4. Arquivos Modificados

### Firmware:
- `estufa_arduino_uno/estufa_arduino_uno.ino` (principal)

### Android App:
- `android/app/src/main/java/com/agrolink/estufa/MainActivity.java`
- `android/app/src/main/AndroidManifest.xml`
- `android/app/build.gradle`
- `android/app/src/main/assets/public/app.js`
- `android/app/src/main/assets/public/index.html`
- `android/app/src/main/assets/public/style.css`
- `android/app/src/main/assets/public/test-smoke.js`

### Raiz (Web/PWA):
- `app.js`
- `index.html`
- `style.css`
- `test-smoke.js`

---

## 5. Próximos Passos (Ação do Usuário)

### Para compilar e testar no Android:
```bash
cd C:\Users\tulio\Documents\Tulio\Interface Estufa\android
.\gradlew assembleDebug
```

### Para fazer upload do firmware no Arduino Uno:
1. Abra `estufa_arduino_uno/estufa_arduino_uno.ino` na Arduino IDE
2. Selecione: Placa → Arduino Uno, Porta → COMx
3. Carregar

### Para commitar e enviar ao GitHub (execute localmente no Windows):
```cmd
cd C:\Users\tulio\Documents\Tulio\Interface Estufa
git add -A
git commit -m "feat: LCD button-only control + push notifications + firmware fixes

- Firmware: BT STATE HIGH=conectado, botão pino 7 INPUT_PULLUP (curto=alterna LCD, longo=irrigação emergência/silencia buzzer)
- Bomba pino 10 Active LOW (LOW=LIGA), Ventoinha pino 13 normal (HIGH=LIGA)
- LCD: Removido timer automático, tela fixa até botão físico ou comando 'L' via BT
- Android: POST_NOTIFICATIONS permission, NotificationChannel, push nativo estilo WhatsApp
- Alertas: water_low, soil_dry, temp_high, pump_failed, bt_lost
- App: Botão 'Alternar LCD' também dispara sync forçado (comando 'T') quando conectado
- UI: Badge notificação posicionado no sino, ícones sensores padronizados (planta/termo)
- RAM: ~500B livres (MAX_REG_OFFLINE=40, CMD_BUF=32, state machines não-bloqueantes)
- Sync: não-bloqueante, WDT a cada loop"
git push origin main
```

> **Importante**: O GitHub PAT precisa ter escopo `Contents:write` (ou `repo` completo) para o push funcionar. Atualize em: https://github.com/settings/tokens