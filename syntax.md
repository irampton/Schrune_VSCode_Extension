# Schrune Syntax

Schrune is a small hardware description language for building schematics, PCBs, and part libraries.

## File Structure

```schrune
#include "Parts.schrune"

module top () {
    // declarations and connections
}
```

Use `#include` to load other `.schrune` files. The compiler also searches below the source directory for matching files.

## Comments

Use `//` for line comments.

```schrune
// This is a comment
```

## Modules

Modules group declarations and wiring. The `top` module is required.

```schrune
module child () {
    rail power;
    net signal;
}

module top () {
    mod c = new child();
}
```

Modules can take parameters.

```schrune
module regulator(vin) {
    rail in;
    rail out;
}
```

Module instances are created with `mod`:

```schrune
mod buck = new DCDC_Buck(5V);
```

When a module is instantiated, its nets are scoped by the instance name.

## Nets

Declare a single net with `net`.

```schrune
net gpio;
```

Connect nets with `~`:

```schrune
gpio ~ part1.IN;
part1.OUT ~ other_net;
```

### Net Types

Typed nets model common protocols as a group of related signals.

Supported net types:

* `i2c` with `SDA` and `SCL`
* `uart` with `RX` and `TX`
* `spi` with `MOSI`, `MISO`, and `CLK`

Example:

```schrune
net<i2c> i2c_bus;
net<i2c> sensor_bus;

i2c_bus ~ sensor_bus;
sensor_bus.SDA ~ sensor.SDA;
sensor_bus.SCL ~ sensor.SCL;
```

Connecting two typed nets expands signal-by-signal.

```schrune
bus_a ~ bus_b;
```

is equivalent to connecting each signal in the group.

## Rails

Rails model paired high and low nets.

```schrune
rail power;
power.voltage = 3.3V;
power.h.name = "VCC";
power.l.name = "GND";
```

Rail sides are accessed with `.h` and `.l`.

```schrune
power.h ~ part1.VIN;
power.l ~ part1.GND;
```

## Parts

Create parts with `part` or bare assignment syntax.

```schrune
part r1 = new Resistor(value = "10kOhm", footprint = "0603");
cap = new Capacitor(value = 100nF, footprint = "0402");
```

The built-in primitives are:

* `Resistor`
* `Capacitor`
* `Inductor`
* `Diode`

For primitive parts, either `value` or `LCSC` must be provided unless the part is selected through the BOM pipeline.

Array instances are supported:

```schrune
part[4] headers = new TestPart();
headers[0].IN ~ gpio0;
headers[1].IN ~ gpio1;
```

## Part Definitions

Part definition files describe reusable libraries that can be included into a design.

```schrune
part TestPart {
    info: {
        partNumber: "TP-1",
        manufacture: "TestCo",
        footprint: "./TestPart.kicad_mod",
        symbol: "./TestPart.kicad_sym",
        designatorPrefix: "U"
    }

    pins: [
        IN:1,
        OUT:2,
    ]
}
```

`info` fields describe the generated and imported asset metadata.

Common fields are:

* `partNumber`
* `manufacture`
* `footprint`
* `symbol`
* `model`
* `LCSC`
* `designatorPrefix`

`pins` maps logical pin names to physical pad numbers. Numeric-only pin names are preserved as pads, and grouped pins are supported with nested arrays.
Use `~` between pad numbers when one logical pin/net is backed by multiple physical pads.
Part pins can also expose rails or typed net groups with object syntax.

```schrune
part Example {
    info: {
        partNumber: "EX-1",
        manufacture: "ExampleCo",
        footprint: "./Example.kicad_mod",
        symbol: "./Example.kicad_sym",
    }

    pins: [
        1:1,
        2:2,
        GND:3~4,
        rail VBUS: {
            h: A4~B4,
            l: A1~B1,
        },
        net<i2c> control: {
            SDA: 5,
            SCL: 6,
        },
        inputs: [
            A:7,
            B:8,
        ],
    ]
}
```

## Part Properties

Part constructors accept named arguments.

```schrune
part r1 = new Resistor(
    value = "10kOhm",
    footprint = "0603",
    tolerance = "1%"
);
```

Common properties used by the compiler include:

* `value`
* `footprint`
* `LCSC`
* `power`
* `voltage`
* `tolerance`
* `package`

## `val`

`val` declares a numeric value with a unit, intended for expressions and validation.

```schrune
val feedback_r1 = 10kOhm;
part r2 = new Resistor(value = feedback_r1 / 2);
```

`val` values support arithmetic and evaluate to their numeric magnitude in expressions.

## Connections

Schrune supports several wiring forms:

```schrune
left[1] ~ right[1];
net gnd ~ power_3v3.l ~ power_1v8.l;
signal ~ left.IN ~ right.IN;
left[1] ~> resistor ~> right[1];
```

Declaring a net inline with `~` is shorthand for declaring the net and connecting
that net to each later endpoint. Multiple `~` endpoints on one line connect each
later endpoint back to the first endpoint.

The bridge operator `~>` is a convenience for chaining through a two-pin part.

## Names

Names can be overridden with `.name`.

```schrune
rail power;
power.h.name = "VCC";
power.l.name = "GND";
net signal;
signal.name = "GPIO28";
```

For typed nets, signal access uses the group name and signal name:

```schrune
net<spi> bus_1;
bus_1.CLK ~ clock_source;
```

## Notes

* `#import` is not supported.
* The top module must be named `top`.
* Generated schematic and PCB output is based on the declared nets, parts, and module hierarchy.
