/* ===========================================================================
 * LDD Practice Lab — Problem Library
 * Each problem = { id, title, difficulty, brief, requirements[], hints[],
 *                  checklist[], solution{ notes[], diagrams{} } }
 * Diagrams are Mermaid source strings.
 * ======================================================================== */

const PROBLEMS = [
  /* ------------------------------------------------------------------ */
  {
    id: "parking-lot",
    title: "Parking Lot System",
    difficulty: "easy",
    brief: `Design a parking lot that supports multiple levels, several spot sizes
(motorcycle, compact, large), vehicle entry/exit, ticketing, and payment on exit.
The system should find an available spot for an incoming vehicle and compute the
fee based on the parked duration.`,
    scope: [
      "Multiple floors, each with a fixed set of spots per size.",
      "Vehicle types: Motorcycle, Car, Truck/Bus.",
      "Issue a ticket on entry, charge on exit.",
      "Hourly pricing; support full-lot handling."
    ],
    hints: [
      "A larger vehicle can occupy a larger-or-equal spot; model that fit rule explicitly.",
      "Keep spot assignment behind a strategy so you can swap 'nearest' vs 'first-free'.",
      "Ticket holds entry time + spot; the gate/exit computes the fee."
    ],
    checklist: [
      "Identified actors (Driver, Attendant/System, Payment)",
      "Vehicle hierarchy or type enum defined",
      "ParkingSpot modeled with a size and occupied state",
      "Ticket captures entry time + assigned spot",
      "A strategy/service decides spot assignment",
      "Fee calculation separated from parking logic",
      "Handled 'lot full' and 'invalid ticket' cases"
    ],
    solution: {
      notes: [
        "Vehicle is abstract with subclasses (Motorcycle, Car, Truck) carrying a size.",
        "ParkingSpot knows its SpotSize and whether it can fit a vehicle.",
        "ParkingLot aggregates Levels; Level aggregates Spots.",
        "SpotAssignmentStrategy is pluggable (nearest-first, best-fit).",
        "FeeStrategy computes cost from duration — keep it out of ParkingLot."
      ],
      diagrams: {
        class: `classDiagram
    class Vehicle {
      <<abstract>>
      +String plate
      +SpotSize size
    }
    class Motorcycle
    class Car
    class Truck
    Vehicle <|-- Motorcycle
    Vehicle <|-- Car
    Vehicle <|-- Truck

    class ParkingSpot {
      +String id
      +SpotSize size
      +bool occupied
      +canFit(Vehicle) bool
      +assign(Vehicle)
      +release()
    }
    class Level {
      +int floor
      +List~ParkingSpot~ spots
      +findSpot(Vehicle) ParkingSpot
    }
    class ParkingLot {
      +List~Level~ levels
      +park(Vehicle) Ticket
      +unpark(Ticket) Payment
    }
    class Ticket {
      +String id
      +DateTime entryTime
      +ParkingSpot spot
    }
    class FeeStrategy {
      <<interface>>
      +calculate(Ticket, DateTime exit) Money
    }
    ParkingLot "1" o-- "*" Level
    Level "1" o-- "*" ParkingSpot
    ParkingLot ..> Ticket : issues
    ParkingLot ..> FeeStrategy : uses
    Ticket --> ParkingSpot`,
        sequence: `sequenceDiagram
    actor Driver
    participant Gate as EntryGate
    participant Lot as ParkingLot
    participant Level
    participant Spot as ParkingSpot
    Driver->>Gate: arrive(vehicle)
    Gate->>Lot: park(vehicle)
    Lot->>Level: findSpot(vehicle)
    Level->>Spot: canFit(vehicle)
    Spot-->>Level: true
    Level-->>Lot: spot
    Lot->>Spot: assign(vehicle)
    Lot-->>Gate: Ticket
    Gate-->>Driver: ticket`
      }
    }
  },

  /* ------------------------------------------------------------------ */
  {
    id: "elevator",
    title: "Elevator Control System",
    difficulty: "medium",
    brief: `Design the control system for a building with N elevators and M floors.
Users press up/down call buttons on floors and floor buttons inside cars. The
system must dispatch an elevator to serve requests efficiently and move cars
between floors while respecting direction.`,
    scope: [
      "Multiple elevator cars sharing a controller.",
      "External (hall) calls with direction + internal (car) requests.",
      "A dispatch strategy chooses which car serves a hall call.",
      "Each car tracks current floor, direction, and a request queue."
    ],
    hints: [
      "Separate ElevatorCar (mechanics/state) from ElevatorController (dispatch).",
      "Model Direction (UP/DOWN/IDLE) and an elevator State machine.",
      "Dispatch is a strategy — nearest-car or SCAN/LOOK scheduling."
    ],
    checklist: [
      "Distinguished hall calls from car calls",
      "ElevatorCar holds current floor + direction + state",
      "Controller owns dispatch decision",
      "Dispatch strategy is pluggable",
      "Request queue / scheduling modeled",
      "Door open/close and moving states represented",
      "Idle behavior defined"
    ],
    solution: {
      notes: [
        "ElevatorController receives Requests and assigns them to an ElevatorCar via DispatchStrategy.",
        "ElevatorCar is a state machine: IDLE -> MOVING -> DOORS_OPEN -> IDLE.",
        "Request carries source floor, destination (for car calls) and direction.",
        "Keep scheduling (which floors next) inside the car; keep assignment (which car) in the controller."
      ],
      diagrams: {
        class: `classDiagram
    class ElevatorController {
      +List~ElevatorCar~ cars
      +DispatchStrategy strategy
      +submitHallCall(Request)
      +submitCarCall(carId, floor)
    }
    class DispatchStrategy {
      <<interface>>
      +selectCar(List~ElevatorCar~, Request) ElevatorCar
    }
    class ElevatorCar {
      +int id
      +int currentFloor
      +Direction direction
      +ElevatorState state
      +addStop(int floor)
      +step()
    }
    class Request {
      +int floor
      +Direction direction
      +int destination
    }
    class Door {
      +open()
      +close()
    }
    ElevatorController "1" o-- "*" ElevatorCar
    ElevatorController --> DispatchStrategy
    ElevatorCar --> Door
    ElevatorController ..> Request`,
        sequence: `sequenceDiagram
    actor User
    participant Ctrl as ElevatorController
    participant Strat as DispatchStrategy
    participant Car as ElevatorCar
    User->>Ctrl: submitHallCall(floor=3, UP)
    Ctrl->>Strat: selectCar(cars, request)
    Strat-->>Ctrl: car #2
    Ctrl->>Car: addStop(3)
    Car->>Car: step() until floor==3
    Car-->>User: doors open at 3`,
        state: `stateDiagram-v2
    [*] --> Idle
    Idle --> Moving : stop added
    Moving --> DoorsOpen : reached target floor
    DoorsOpen --> Moving : more stops
    DoorsOpen --> Idle : queue empty
    Moving --> Moving : passing floor`
      }
    }
  },

  /* ------------------------------------------------------------------ */
  {
    id: "library",
    title: "Library Management System",
    difficulty: "easy",
    brief: `Design a library system where members can search the catalog, borrow and
return books, and reserve titles that are currently out. Librarians manage the
catalog and handle fines for late returns.`,
    scope: [
      "Catalog of BookItems (physical copies of a Book title).",
      "Members borrow up to a max number of books with due dates.",
      "Reservations when all copies are checked out.",
      "Fines accrue on overdue returns."
    ],
    hints: [
      "Separate the abstract Book (title/author/ISBN) from a BookItem (a physical copy with a barcode).",
      "A Loan links a Member to a BookItem with issue and due dates.",
      "Reservation and Fine are first-class entities, not booleans."
    ],
    checklist: [
      "Book vs BookItem distinction made",
      "Member with borrowing limit modeled",
      "Loan/Checkout entity with due date",
      "Reservation flow for unavailable copies",
      "Fine calculation on overdue",
      "Catalog search abstraction",
      "Librarian actions separated from Member actions"
    ],
    solution: {
      notes: [
        "Book = catalog metadata; BookItem = one shelved copy with a barcode and status.",
        "Loan is the association object between Member and BookItem.",
        "Catalog provides search by title/author/subject.",
        "Fine is derived from overdue days * daily rate, modeled as its own entity for auditability."
      ],
      diagrams: {
        class: `classDiagram
    class Book {
      +String isbn
      +String title
      +String author
    }
    class BookItem {
      +String barcode
      +BookStatus status
      +Date dueDate
    }
    class Member {
      +String id
      +int maxBooks
      +List~Loan~ loans
      +checkout(BookItem)
      +returnItem(BookItem)
    }
    class Loan {
      +Date issueDate
      +Date dueDate
      +Date returnDate
    }
    class Reservation {
      +Date reservedOn
      +ReservationStatus status
    }
    class Fine {
      +Money amount
      +bool paid
    }
    class Catalog {
      +search(String query) List~Book~
    }
    Book "1" o-- "*" BookItem
    Member "1" o-- "*" Loan
    Loan --> BookItem
    Member ..> Reservation
    Loan ..> Fine
    Catalog o-- Book`,
        sequence: `sequenceDiagram
    actor Member
    participant Sys as LibrarySystem
    participant Cat as Catalog
    participant Item as BookItem
    Member->>Sys: search("Clean Code")
    Sys->>Cat: search(query)
    Cat-->>Sys: [Book]
    Member->>Sys: checkout(barcode)
    Sys->>Item: isAvailable()
    Item-->>Sys: true
    Sys->>Item: markLoaned(dueDate)
    Sys-->>Member: Loan(dueDate)`
      }
    }
  },

  /* ------------------------------------------------------------------ */
  {
    id: "vending",
    title: "Vending Machine",
    difficulty: "easy",
    brief: `Design a vending machine. A customer selects a product, inserts coins/notes,
and the machine dispenses the product plus change. Model the machine as a state
machine (idle, collecting money, dispensing).`,
    scope: [
      "Inventory of products with price and stock.",
      "Accept money incrementally; track inserted amount.",
      "Dispense product and return change.",
      "Handle insufficient funds, sold-out, and cancel/refund."
    ],
    hints: [
      "The State pattern is the intended answer: Idle, HasMoney, Dispensing, SoldOut.",
      "Each state defines what selectProduct / insertMoney / dispense do.",
      "Keep the coin/change logic in an Inventory/CashBox helper, not in states."
    ],
    checklist: [
      "Modeled machine states explicitly",
      "State transitions for insert/select/dispense/cancel",
      "Product + Inventory with stock",
      "Change computation / CashBox",
      "Insufficient-funds and sold-out handling",
      "Refund on cancel"
    ],
    solution: {
      notes: [
        "VendingMachine delegates behavior to the current State object (State pattern).",
        "States: IdleState, HasMoneyState, DispenseState, SoldOutState.",
        "Inventory tracks Product stock; CashBox tracks coins for change.",
        "Transitions live inside the states, keeping the machine thin."
      ],
      diagrams: {
        class: `classDiagram
    class VendingMachine {
      +State state
      +Inventory inventory
      +CashBox cashBox
      +selectProduct(code)
      +insertMoney(Money)
      +dispense()
      +cancel()
    }
    class State {
      <<interface>>
      +selectProduct(code)
      +insertMoney(Money)
      +dispense()
      +cancel()
    }
    class IdleState
    class HasMoneyState
    class DispenseState
    class SoldOutState
    State <|.. IdleState
    State <|.. HasMoneyState
    State <|.. DispenseState
    State <|.. SoldOutState
    class Inventory {
      +getStock(code) int
      +reduce(code)
    }
    class CashBox {
      +add(Money)
      +makeChange(Money) Money
    }
    VendingMachine --> State
    VendingMachine --> Inventory
    VendingMachine --> CashBox`,
        state: `stateDiagram-v2
    [*] --> Idle
    Idle --> HasMoney : insertMoney
    HasMoney --> HasMoney : insertMoney
    HasMoney --> Dispensing : enough funds + select
    HasMoney --> Idle : cancel / refund
    Dispensing --> Idle : product + change released
    Idle --> SoldOut : stock == 0
    SoldOut --> Idle : restocked`
      }
    }
  },

  /* ------------------------------------------------------------------ */
  {
    id: "ride-hailing",
    title: "Ride-Hailing Service (Uber-like)",
    difficulty: "hard",
    brief: `Design the core of a ride-hailing service. Riders request trips from a
pickup to a drop-off; the system matches a nearby available driver, tracks the
trip lifecycle, and computes fare on completion. Support surge pricing.`,
    scope: [
      "Riders and Drivers with live location + availability.",
      "Trip request -> driver matching -> ride -> completion -> payment.",
      "Pluggable matching (nearest driver) and pricing (base + surge).",
      "Trip state machine from REQUESTED to COMPLETED/CANCELLED."
    ],
    hints: [
      "Model Trip as a lifecycle entity with a status enum/state machine.",
      "MatchingStrategy and PricingStrategy should both be interfaces.",
      "A DriverLocationService / index answers 'who is near here' — don't scan all drivers inline."
    ],
    checklist: [
      "Rider and Driver entities with location",
      "Trip lifecycle / state machine",
      "Matching abstracted behind a strategy",
      "Pricing (base + surge) abstracted",
      "Driver availability tracked",
      "Payment on completion",
      "Cancellation paths handled"
    ],
    solution: {
      notes: [
        "TripService orchestrates: request -> match -> start -> complete.",
        "MatchingStrategy queries a location index for nearby available drivers.",
        "PricingStrategy composes base fare + distance + surge multiplier.",
        "Trip is a state machine; Payment is created on completion.",
        "Keep driver discovery in a dedicated service so matching stays O(nearby) not O(all drivers)."
      ],
      diagrams: {
        class: `classDiagram
    class Rider {
      +String id
      +Location location
      +requestTrip(dest) Trip
    }
    class Driver {
      +String id
      +Location location
      +bool available
    }
    class Trip {
      +String id
      +Location pickup
      +Location dropoff
      +TripStatus status
      +Fare fare
    }
    class TripService {
      +requestTrip(Rider, dest) Trip
      +completeTrip(Trip)
    }
    class MatchingStrategy {
      <<interface>>
      +findDriver(Trip) Driver
    }
    class PricingStrategy {
      <<interface>>
      +price(Trip) Fare
    }
    class LocationService {
      +nearbyDrivers(Location, radius) List~Driver~
    }
    TripService ..> MatchingStrategy
    TripService ..> PricingStrategy
    MatchingStrategy ..> LocationService
    TripService o-- Trip
    Trip --> Rider
    Trip --> Driver`,
        sequence: `sequenceDiagram
    actor Rider
    participant TS as TripService
    participant MS as MatchingStrategy
    participant LS as LocationService
    participant Driver
    participant PS as PricingStrategy
    Rider->>TS: requestTrip(dest)
    TS->>MS: findDriver(trip)
    MS->>LS: nearbyDrivers(pickup, r)
    LS-->>MS: [drivers]
    MS-->>TS: driver
    TS->>Driver: assign(trip)
    Driver-->>Rider: on the way
    Rider->>TS: completeTrip()
    TS->>PS: price(trip)
    PS-->>TS: fare
    TS-->>Rider: receipt(fare)`,
        state: `stateDiagram-v2
    [*] --> Requested
    Requested --> Matched : driver assigned
    Requested --> Cancelled : no driver / rider cancels
    Matched --> EnRoute : driver arrives, trip starts
    Matched --> Cancelled : rider/driver cancels
    EnRoute --> Completed : reached dropoff
    Completed --> [*]
    Cancelled --> [*]`
      }
    }
  },

  /* ------------------------------------------------------------------ */
  {
    id: "url-shortener",
    title: "URL Shortener (LDD view)",
    difficulty: "medium",
    brief: `Design the object model and core flow for a URL shortener. Users submit a
long URL and receive a short code; visiting the short code redirects to the
original URL. Support custom aliases, expiry, and click analytics. Also sketch
the data model (ER).`,
    scope: [
      "Create short code for a long URL (auto or custom alias).",
      "Resolve short code -> long URL (redirect).",
      "Optional expiry per link.",
      "Track click count / basic analytics."
    ],
    hints: [
      "Separate the encoding strategy (base62 of an ID, or hash) behind an interface.",
      "A repository/DAO hides storage; service holds business rules.",
      "For the ER diagram: a URLMapping table plus a ClickEvent table referencing it."
    ],
    checklist: [
      "ShorteningService with create + resolve",
      "Encoding strategy abstracted (base62/hash)",
      "URLMapping entity (code, longUrl, expiry, owner)",
      "Custom alias collision handling",
      "Expiry checked on resolve",
      "Analytics / click tracking modeled",
      "ER model with relationships drawn"
    ],
    solution: {
      notes: [
        "ShorteningService.create() delegates code generation to an EncodingStrategy and persists a URLMapping.",
        "resolve(code) looks up the mapping, checks expiry, records a ClickEvent, returns the long URL.",
        "EncodingStrategy is pluggable: Base62 of an auto-increment ID or a hash-based scheme.",
        "ER model: URLMapping 1..* ClickEvent; URLMapping optionally references a User owner."
      ],
      diagrams: {
        class: `classDiagram
    class ShorteningService {
      +create(longUrl, alias) URLMapping
      +resolve(code) String
    }
    class EncodingStrategy {
      <<interface>>
      +encode(long id) String
    }
    class Base62Encoder
    EncodingStrategy <|.. Base62Encoder
    class URLMapping {
      +String code
      +String longUrl
      +DateTime createdAt
      +DateTime expiresAt
      +long clicks
    }
    class URLRepository {
      <<interface>>
      +save(URLMapping)
      +findByCode(code) URLMapping
    }
    class ClickEvent {
      +DateTime at
      +String referrer
      +String country
    }
    ShorteningService ..> EncodingStrategy
    ShorteningService ..> URLRepository
    URLRepository o-- URLMapping
    URLMapping "1" o-- "*" ClickEvent`,
        sequence: `sequenceDiagram
    actor User
    participant Svc as ShorteningService
    participant Enc as EncodingStrategy
    participant Repo as URLRepository
    User->>Svc: create(longUrl)
    Svc->>Repo: nextId()
    Repo-->>Svc: id
    Svc->>Enc: encode(id)
    Enc-->>Svc: "aZ3x"
    Svc->>Repo: save(mapping)
    Svc-->>User: short code aZ3x
    User->>Svc: resolve("aZ3x")
    Svc->>Repo: findByCode("aZ3x")
    Repo-->>Svc: mapping
    Svc-->>User: 302 -> longUrl`,
        er: `erDiagram
    USER ||--o{ URL_MAPPING : owns
    URL_MAPPING ||--o{ CLICK_EVENT : records
    USER {
      string id PK
      string email
    }
    URL_MAPPING {
      string code PK
      string long_url
      string owner_id FK
      datetime created_at
      datetime expires_at
    }
    CLICK_EVENT {
      long id PK
      string code FK
      datetime at
      string referrer
    }`
      }
    }
  }
];

// expose globally for app.js
window.PROBLEMS = PROBLEMS;
