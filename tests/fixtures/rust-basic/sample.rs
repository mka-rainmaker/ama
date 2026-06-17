pub trait Shape {
    fn area(&self) -> f64;
}

pub struct Circle {
    radius: f64,
}

pub enum Color {
    Red,
    Green,
}

pub fn main() {}
