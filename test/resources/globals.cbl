       IDENTIFICATION DIVISION.
       PROGRAM-ID. globals.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       77 FOO PIC 999 GLOBAL.
       01 BAR GLOBAL.
         02 BAR-1 PIC 9.
         02 BAR-2 PIC XXX.
       01 BAZ.
         02 BAZ-1 PIC X.
         02 BAZ-2 BINARY-SHORT.
       77 FXX PIC 999.
       PROCEDURE DIVISION.
           MOVE 3 TO BAR-1
           DISPLAY FOO
           DISPLAY BAZ-2
           DISPLAY BAR-1
           DISPLAY BAR-2
           DISPLAY BAZ-1
           DISPLAY FXX
           CALL "globals2"
           GOBACK.
