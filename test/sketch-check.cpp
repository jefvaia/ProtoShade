// Pulls the sketch into one translation unit so a host compiler can parse it. The Arduino
// IDE concatenates .ino files and generates prototypes; including it works because every
// function in ours is defined before it is used.
#include "../protoshade.ino"
