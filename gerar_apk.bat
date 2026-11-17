@echo off
chcp 65001 > nul
echo =========================================================================
echo               AGROLINK - GERADOR DO APLICATIVO ANDROID (.APK)
echo =========================================================================
echo.
echo [1/3] Sincronizando arquivos atualizados do AgroLink para o Android...
xcopy /Y /Q "index.html" "android\app\src\main\assets\public\" > nul
xcopy /Y /Q "style.css" "android\app\src\main\assets\public\" > nul
xcopy /Y /Q "app.js" "android\app\src\main\assets\public\" > nul
xcopy /Y /Q "manifest.json" "android\app\src\main\assets\public\" > nul
xcopy /Y /Q "assets\logo.png" "android\app\src\main\assets\public\assets\" > nul
echo Arquivos sincronizados com sucesso!
echo.

echo [2/3] Verificando ferramentas de compilação Android...
where gradle >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    echo Gradle detectado! Compilando APK em modo Debug...
    cd android
    call gradle assembleDebug
    cd ..
    echo.
    echo [3/3] SUCESSO! O arquivo .apk foi gerado em:
    echo       android\app\build\outputs\apk\debug\app-debug.apk
) else (
    echo.
    echo [3/3] COMO ATUALIZAR E INSTALAR O APP AGROLINK NO CELULAR:
    echo.
    echo   OPCAO A - Gerar novo APK no Android Studio (Recomendado):
    echo     1. Abra o Android Studio.
    echo     2. Abra a pasta "android" deste projeto.
    echo     3. No menu superior, clique em "Build" ^> "Build Bundle(s) / APK(s)" ^> "Build APK(s)".
    echo     4. Transfira o arquivo "app-debug.apk" para o celular e instale!
    echo.
    echo   OPCAO B - Atualizacao Imediata no Navegador do Celular (PWA):
    echo     1. Abra no Chrome do celular: https://tulio713645.github.io/smart-estufa-web-app/
    echo     2. Se ja tinha instalado, basta recarregar a pagina (arrastar para baixo).
    echo     3. Todas as novidades entram em vigor instantaneamente!
)
echo.
echo =========================================================================
pause
