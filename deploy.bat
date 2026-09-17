@echo off
setlocal enabledelayedexpansion
title SBR Budget - Envoi vers GitHub

set REPO_URL=https://github.com/Bersaaaa/sbrbudget.git

REM ============================================================================
REM  deploy.bat - SBR Budget
REM
REM  A placer a la racine du depot Git local.
REM  A chaque double-clic :
REM    1) initialise le depot Git si besoin (1ere fois uniquement)
REM    2) recupere les dernieres modifications de GitHub
REM    3) ajoute les fichiers modifies
REM    4) cree un commit
REM    5) envoie les modifications sur GitHub
REM
REM  Depot GitHub :
REM  https://github.com/Bersaaaa/sbrbudget
REM ============================================================================

echo ============================================
echo   SBR BUDGET - Envoi vers GitHub
echo ============================================
echo.

REM Verifie que Git est installe
where git >nul 2>nul
if errorlevel 1 (
    echo [ERREUR] Git n'est pas installe ou introuvable dans le PATH.
    echo Installe Git pour Windows puis relance ce script.
    echo.
    pause
    exit /b 1
)

REM Verifie qu'on est bien dans un depot Git, sinon l'initialise
git rev-parse --is-inside-work-tree >nul 2>nul
if errorlevel 1 (
    echo Ce dossier n'est pas encore un depot Git : initialisation...
    git init
    git branch -M main
    echo.
)

REM Verifie que le depot distant est bien configure
git remote get-url origin >nul 2>nul
if errorlevel 1 (
    echo Configuration du depot distant GitHub...
    git remote add origin %REPO_URL%
    echo.
)

echo --- Depot Git utilise ---
git remote -v
echo.

REM Verifie que .env ne sera jamais envoye sur GitHub
if not exist ".gitignore" (
    echo node_modules/> .gitignore
    echo .env>> .gitignore
    echo .env.local>> .gitignore
    echo .vercel>> .gitignore
    echo *.log>> .gitignore
)
findstr /x ".env" .gitignore >nul 2>nul || echo .env>> .gitignore

if exist ".env" (
    echo [ATTENTION] Un fichier .env existe dans ce dossier.
    echo Il contient vos secrets ^(Supabase, cles bancaires...^) et ne sera
    echo pas envoye sur GitHub grace au .gitignore.
    echo.
)

echo --- Recuperation des dernieres modifications GitHub ---
git pull origin main --no-edit
if errorlevel 1 (
    echo.
    echo [ERREUR] Impossible de recuperer les modifications de GitHub.
    echo Si c'est le tout premier envoi, cette erreur est normale
    echo ^(le depot GitHub est encore vide^) : le script continue.
    echo Sinon, verifie s'il y a un conflit Git a resoudre.
    echo.
)

echo.
echo --- Fichiers modifies ---
git status --short
echo.

set /p msg="Message pour cette mise a jour (Entree = message par defaut) : "
if "%msg%"=="" set msg=Mise a jour SBR Budget

echo.
echo --- Ajout des fichiers ---
git add -A

echo.
echo --- Creation du commit ---
git diff --cached --quiet
if not errorlevel 1 (
    echo.
    echo Aucun fichier modifie a envoyer.
    echo.
    pause
    exit /b 0
)

git commit -m "%msg%"
if errorlevel 1 (
    echo.
    echo [ERREUR] Impossible de creer le commit.
    echo.
    pause
    exit /b 1
)

echo.
echo --- Envoi vers GitHub ---
git push -u origin main
if errorlevel 1 (
    echo.
    echo [ERREUR] L'envoi vers GitHub a echoue.
    echo Verifie ta connexion et les droits du depot.
    echo.
    pause
    exit /b 1
)

echo.
echo ============================================
echo   TERMINE !
echo   Les modifications sont maintenant
echo   envoyees sur GitHub.
echo   Vercel redeploiera automatiquement si le
echo   projet y est relie.
echo ============================================
echo.
pause
