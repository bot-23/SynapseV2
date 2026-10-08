// Windows 下隐藏控制台窗口；其它平台 release 下也走 windows 子系统无副作用
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    synapse_desktop_lib::run()
}
