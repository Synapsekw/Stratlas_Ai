@echo off
"%FAKE_ODM_PYTHON%" "%~dp0fake_odm.py" %*
exit /b %ERRORLEVEL%
