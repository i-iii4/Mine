//! Line-oriented native runner for the same commands exercised through WASM.
use std::io::{self, BufRead};

fn main() -> io::Result<()> {
    for line in io::stdin().lock().lines() {
        println!("{}", mine_core::save::execute_json(&line?));
    }
    Ok(())
}
