@echo off
chcp 65001 > nul
echo =========================================================================
echo               AGROLINK - GERADOR DO APLICATIVO ANDROID (.APK)
echo =========================================================================
echo.
echo [1/3] Sincronizando arquivos do aplicativo para o projeto Android...
xcopy /Y /Q "index.html" "android\app\src\main\assets\public\" > nul
xcopy /Y /Q "style.css" "android\app\src\main\assets\public\" > nul
xcopy /Y /Q "app.js" "android\app\src\main\assets\public\" > nul
xcopy /Y /Q "manifest.json" "android\app\src\main\assets\public\" > nul
xcopy /Y /Q "assets\logo.png" "android\app\src\main\assets\public\assets\" > nul
echo Arquivos sincronizados com sucesso!
echo.

echo [2/3] Verificando ambiente de compilação Android...
where gradle >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    echo Gradle encontrado no sistema! Iniciando compilacao do APK...
    cd android
    gradle assembleDebug
    cd ..
    echo.
    echo [3/3] APK gerado em: android\app\build\outputs\apk\debug\app-debug.apk
) else (
    echo.
    echo O Gradle CLI nao esta instalado diretamente no PATH do Windows.
    echo Para gerar o arquivo .apk de forma imediata:
    echo.
    echo  OPCAO A (Android Studio):
    echo    1. Abra o Android Studio.
    echo    2. Clique em "Open" e selecione a pasta:
    echo       "%CD%\android"
    echo    3. No menu superior, clique em "Build" ^> "Build Bundle(s) / APK(s)" ^> "Build APK(s)".
    echo    4. O Android Studio ira gerar o arquivo "AgroLink.apk" pronto para instalar no celular!
    echo.
    echo  OPCAO B (PWA no Navegador do Celular):
    echo    1. Acesse https://tulio713645.github.io/smart-estufa-web-app/ no Chrome do celular.
    echo    2. Toque nos 3 pontinhos e selecione "Instalar aplicativo" ou "Adicionar a tela inicial".
    echo    3. O icone oficial do AgroLink sera instalado instantaneamente no celular!
)
echo.
echo =========================================================================
pause
