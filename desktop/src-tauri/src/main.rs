// The app is a bundle without a terminal window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    hatch_desktop::run();
}
