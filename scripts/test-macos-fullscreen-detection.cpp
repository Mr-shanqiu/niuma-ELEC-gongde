#include "../src/macos/fullscreen_detection.h"
#include <cassert>
#include <cstdio>
using niuma::macos::FullscreenOnDisplay;
using R=niuma::macos::FullscreenRect;
int main(){
 const R screen{2560,0,2560,1440,0};
 const R usable{2560,30,2560,1346,0};constexpr int self=41;
 // Fullscreen on the pet display while another display has the global focus.
 assert(FullscreenOnDisplay(screen,usable,{{0,0,2560,1440,5},{2560,0,2560,1440,9}},self));
 assert(!FullscreenOnDisplay(screen,usable,{{0,0,2560,1440,5}},self));
 assert(!FullscreenOnDisplay(screen,usable,{{2560,0,2560,1440,self}},self));
 // A maximized window filling the usable area hides, like fullscreen.
 assert(FullscreenOnDisplay(screen,usable,{{2560,30,2560,1346,9}},self));
 assert(FullscreenOnDisplay(screen,usable,{{2560,45,2520,1318,9}},self));
 // A regular smaller window does not hide.
 assert(!FullscreenOnDisplay(screen,usable,{{2960,129,1767,1239,9}},self));
 // A smaller foreground window on this display wins over a maximized window behind it.
 assert(!FullscreenOnDisplay(screen,usable,{{2960,129,1767,1239,9},{2560,0,2560,1440,10}},self));
 // A small overlay does not mask the maximized app underneath.
 assert(FullscreenOnDisplay(screen,usable,{{3000,200,200,160,9},{2560,30,2560,1346,10}},self));
 // Fullscreen browser content and toolbar reported as two same-owner pieces.
 assert(FullscreenOnDisplay(screen,usable,{{2560,0,2560,158,9},{2560,122,2560,1318,9}},self));
 assert(!FullscreenOnDisplay(screen,usable,{{2560,0,2560,158,9},{2560,122,2560,1318,10}},self));
 assert(!FullscreenOnDisplay(screen,usable,{{2560,0,2560,100,9},{2560,130,2560,1310,9}},self));
 assert(!FullscreenOnDisplay(screen,usable,{{2560,0,2560,30,9},{2560,100,2560,1340,9}},self));
 assert(!FullscreenOnDisplay(screen,usable,{},self));
 puts("PASS fullscreen: same display, another display focus, split same-owner window, ordinary maximize, smaller window and gap rejection");
}
