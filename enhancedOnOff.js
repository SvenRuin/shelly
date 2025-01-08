// Based on priceBasedOnOff_for_1.0.xV.js for on/off load control according to Swedish electricity prices, see https://github.com/MikaelUlvesjo/shelly
// Copyright (c) 2023 MikaelUlvesjo

// Modifications by Sven Ruin for TEROC AB, in order to also use internal temperature for control (to avoid that the building gets too cold)
// Copyright (c) 2024-2025 TEROC AB
// This file was updated 2025-01-08 and has been tested successfully on Shelly Pro3 Smart Switch for load control of a heat storage tank in a building

/*
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

let CONFIG = {
    priceApiEndpoint: "https://www.elprisetjustnu.se/api/v1/prices/", // see https://www.elprisetjustnu.se/elpris-api
    tomorrowsPricesAfter: 15, // will get tomorrows prices if the time is after 15 for 15:00
    timezone: 1, // in positive or negative value e.g: 1 for CET or -6 for CST
    daylightSaving: true, // boolean, if true and date is after last Sunday in March and Before last Sunday in October then 1 hour will be added to timezone.
    zone: "SE3", // SE1, SE2, SE3 or SE4
    inUseLimit: -1.0, // watts required to consider the controlled unit to be running and to not switch it off, for non power meter units set this to -1.0 
    updateTime: 900, // 3600 is every hour, 900 is every 15 minutes. Price update interval in seconds
    switchId: 0, // the id of the first switch to control, starts at 0
    switches: 3, // the number of switches to control, max 3 for Shelly Pro3 Smart Switch
    alwaysOnMaxPrice: 0.05, // SEK/kWh. If the price is below or equal this value the switch(es) should be on no matter if checkNextXHours would turn it off (price without tax or other fees)
    //alwaysOffMinPrice: 10.0, // SEK/kWh. NOT USED. If the price is above or equal this value the switch should be off no matter if normallyOnHours would suggest turning it on (price without tax or other fees)
    normallyOnHours: [{ from: 0, to: 6 }], // time spans when normally on, format [{from: 8, to: 8},{from: 20, to: 23}] to have it on from 8:00-8:59 and 20:00 to 23:59
    onOffLimit: 1.1, // is used to set the price limit where to turn on and of switch(es)
    // so if current price > (avg price * onOffLimit) then turn off
    // and if current price <= (avg price * onOffLimit) then turn on
    checkNextXHours: 0, // check that the price does not go over the limit the next x hours, if it does then switch off now
    // will check until a price that will switch off or all hour have low price
    stopAtDataEnd: true,
    // if stopAtDataEnd is false will only check values that exists in the data and if it passes the end of the data it will start from the first value,
    // if stopAtDataEnd is true will only check current days values and if it passes the end of the data it will stop checking more values
    invertSwitch: false, // invert the switch action. Set inUseLimit: -1.0 to use this
    debugMode: false, // set to false to enable switching of power
    switchMode: true, // set to true to switch power on and of based on price
    colorMode: false, // set to true to change color on shelly plus plug s led from green to red based on price. Lowest price of the day will be green and heighest price of the day will be red
    // "Settings" -> "Led indicator color mode" have to be set to "switch"  
    colors: ["0%2c100%2c0", "100%2c100%2c0", "100%2c0%2c100", "100%2c0%2c0"], // (red,green,blue from 0 to 100 url encoded string no spaces ',' is '%2c') Colors used for shelly plus plug s led
    // Can be any number of colors where the first one is for the lowest price and the last for the max price
    lowIntTempLimit: 30, // °C. If internal temperature is below or equal to this limit the switch(es) should always be on (30 corresponds to an ambient temperature of approx 12°C, when outputs are off)
    lowIntTempHyst: 20 // hysteresis for temperature control
};

let prices = [];
let avg = null;
let min = null;
let max = null;
let state = null;
let date = null;
let lastDate = null;
let currentSwitchState = null;
let debugSwitchState = null;
let powerUsage = 0.0;
let nextAtemptToGetData = 0;
let internalTemperature = 0;
let lowIntTempOverride = true;

function sendRequest(api, data, callback, userData) {
    Shelly.call(api, data, callback, userData);
}

function scheduleNextRun() {
    print("Current date and time: " + date.date);
    //print(date.epoch);
    let nextTimeToNextRun = (CONFIG.updateTime) - (((date.minute * 60) + date.second) % (CONFIG.updateTime));
    let nextDate = epochToDate(date.epoch + nextTimeToNextRun, CONFIG.timezone, CONFIG.daylightSaving);
    if (nextTimeToNextRun < (CONFIG.updateTime / 3) && date.hour === nextDate.hour) {
        print("Will skip one close run");
        nextTimeToNextRun = nextTimeToNextRun + CONFIG.updateTime;
        nextDate = epochToDate(date.epoch + nextTimeToNextRun, CONFIG.timezone, CONFIG.daylightSaving);
    }
    print("Next run: " + nextDate.date);
    Timer.set(nextTimeToNextRun * 1000, false, start);
}

function start() {
    if (CONFIG.inUseLimit < 0.0) {
        getCurrentDate();
    } else {
        getCurrentUsage();
    }
}

function getCurrentDate() {
    sendRequest("Sys.GetStatus",
        {
            id: CONFIG.switchId,
        }, processCurrentDate);
}

function processCurrentDate(response, errorCode, errorMessage) {
    if (errorCode !== 0) {
        print(errorMessage);
        return;
    }
    date = epochToDate(response.unixtime, CONFIG.timezone, CONFIG.daylightSaving);
    scheduleNextRun();
    getCurrentUsage();
}

function getCurrentUsage() {
    sendRequest("switch.getstatus",
        {
            id: CONFIG.switchId,
        }, processCurrentUsageResponse);
}

function processCurrentUsageResponse(response, errorCode, errorMessage) {
    if (errorCode !== 0) {
        print(errorMessage);
        return;
    }
    currentSwitchState = response.output;
    if (CONFIG.inUseLimit >= 0) {
        date = epochToDate(response.aenergy.minute_ts, CONFIG.timezone, CONFIG.daylightSaving);
        scheduleNextRun();
        powerUsage = response.apower;
    } else {
        powerUsage = 0.0;
    }
    if (CONFIG.debugMode) {
        debugSwitchState = debugSwitchState === null ? currentSwitchState : debugSwitchState;
        if (currentSwitchState !== debugSwitchState) {
            print("Overiding currentSwitchState (" + (currentSwitchState ? "on" : "off") + ") with debugSwitchState: " + (debugSwitchState ? "on" : "off"));
        }
        currentSwitchState = debugSwitchState;
    }
    getCurrentPrice(0);
}

function getInternalTemperature() {
    sendRequest("switch.getstatus",
        {
            id: CONFIG.switchId,
        }, processIntTempResponse);
}

function processIntTempResponse(response, errorCode, errorMessage) {
    if (errorCode !== 0) {
        print(errorMessage);
        return;
    }
    internalTemperature = Math.round(response.temperature.tC);
    print("Internal temperature: " + internalTemperature + "°C");
    if (internalTemperature <= CONFIG.lowIntTempLimit) {
      lowIntTempOverride = true;
      print("WARNING: LOW INTERNAL TEMPERATURE");
    }
    else if (internalTemperature > CONFIG.lowIntTempLimit + CONFIG.lowIntTempHyst) {
      lowIntTempOverride = false;
      print("Override off for low internal temperature");
    }
}

function getCurrentPrice(offset) {
    if (nextAtemptToGetData < date.epoch && offset === 0 && (lastDate === null || lastDate.day !== date.day || prices.length === 0)) {
        let apiUrl = CONFIG.priceApiEndpoint + date.yearStr + "/" + date.monthStr + "-" + date.dayStr + "_" + CONFIG.zone + ".json";
        print("Get prices from: " + apiUrl);
        sendRequest(
            "http.get",
            {
                url: apiUrl,
            }, processCurrentPriceResponse, { offset: offset });
    } else if (nextAtemptToGetData < date.epoch && offset > 0) {
        let offsetDate = epochToDate(date.epoch + (60 * 60 * offset), CONFIG.timezone, CONFIG.daylightSaving);
        let apiUrl = CONFIG.priceApiEndpoint + offsetDate.yearStr + "/" + offsetDate.monthStr + "-" + offsetDate.dayStr + "_" + CONFIG.zone + ".json";
        print("Get tomorrows prises from: " + apiUrl);
        sendRequest(
            "http.get",
            {
                url: apiUrl,
            }, processCurrentPriceResponse, { offset: offset });
    } else if (prices.length !== 0) {
        setColor();
        switchOnOrOff();
    }
}

function processCurrentPriceResponse(response, errorCode, errorMessage, userdata) {
    if (errorCode !== 0) {
        print(errorMessage);
        return;
    }
    if (userdata.offset === 0) {
        prices = [];
    }
    if (response.code !== 200) {
        nextAtemptToGetData = date.epoch + 1800; // Wait 30 minutes before trying again
        print("Error getting price with offset " + JSON.stringify(userdata.offset) + " got error: " + JSON.stringify(response.code) + " " + response.message);
        if (prices.length === 0) {
            print("No price information availible, will retry");
            lastDate = null;
            return;
        } else {
            print("Today's price is available, will use that information, will retry to get tomorrow's prices");
            setColor();
            switchOnOrOff();
            return;
        }
    }

    let data = JSON.parse(response.body);
    let sum = 0.0;
    min = null;
    max = null;

    for (let i in data) {
        let o = data[i];
        let h = JSON.parse(o.time_start.slice(11, 13)) + userdata.offset;
        prices[h] = o.SEK_per_kWh;
        sum += o.SEK_per_kWh;
        min = min === null || o.SEK_per_kWh < min ? o.SEK_per_kWh : min;
        max = max === null || o.SEK_per_kWh > max ? o.SEK_per_kWh : max;
    }
    avg = userdata.offset === 0 ? sum / data.length : avg;
    if (userdata.offset === 0) {
        lastDate = date;
    }
    if (prices.length === 24 && date.hour >= CONFIG.tomorrowsPricesAfter) {
        getCurrentPrice(24);
        return;
    }
    print(date.date + ": Hour " + JSON.stringify(date.hour) + ", current price " + JSON.stringify(prices[date.hour]) + " SEK/kWh, min price today " + JSON.stringify(min) + " SEK/kWh, max price today " + JSON.stringify(max) + " SEK/kWh, avg price today " + JSON.stringify(avg) + " SEK/kWh, always on " + JSON.stringify(CONFIG.alwaysOnMaxPrice) + " SEK/kWh" /*, always off " + JSON.stringify(CONFIG.alwaysOffMinPrice) + " SEK/kWh"*/ );
    setColor();
    switchOnOrOff();
}

function switchOnOrOff() {
    if (!CONFIG.switchMode) {
        return;
    }
    getInternalTemperature();
    let limit = avg * CONFIG.onOffLimit;
    let newSwitchState = true;
    for (let i = 0; i <= CONFIG.checkNextXHours && newSwitchState; i++) {
        let h = (date.hour + i) % prices.length;
        let price = prices[h];
        newSwitchState = newSwitchState && (price <= CONFIG.alwaysOnMaxPrice || price <= limit);
        print(date.date + ": Hour " + JSON.stringify(h) + ", price " + JSON.stringify(price) + " SEK/kWh " + (newSwitchState ? "<=" : ">") + " always on or limit " + JSON.stringify(limit));
        if (h >= prices.length && CONFIG.stopAtDataEnd) {
            print("Stopping check at data end");
            i = 99999; // a high value to stop the loop
        }
    }
    for (let i = 0; i < CONFIG.normallyOnHours.length && !newSwitchState; i++) {
        if (date.hour >= CONFIG.normallyOnHours[i].from && date.hour <= CONFIG.normallyOnHours[i].to) {
            print("Overriding switch(es) to on as current hour is within normallyOnHours");
            newSwitchState = true;
        }
    }
    if (!newSwitchState && prices[date.hour] <= CONFIG.alwaysOnMaxPrice) {
        print("Overriding switch(es) to on as current price is below always on");
        newSwitchState = true;
    }
    /*
    if (newSwitchState && prices[date.hour] >= CONFIG.alwaysOffMinPrice) {
        print("Overriding switch(es) to off as current price is above always off");
        newSwitchState = false;
    }
    */
    if (powerUsage >= CONFIG.inUseLimit && CONFIG.inUseLimit >= 0.0) {
        print("Power usage is over inUseLimit: " + JSON.stringify(powerUsage) + " >= " + JSON.stringify(CONFIG.inUseLimit));
        newSwitchState = true;
    }
    if (lowIntTempOverride) {
        print("Overriding switch(es) to on because of low internal temperature");
        newSwitchState = true;
    }
    if (CONFIG.invertSwitch) {
        newSwitchState = !newSwitchState;
        print("Inverting wanted switch(es) state to: " + (newSwitchState ? "on" : "off"));
    }

    if (currentSwitchState === newSwitchState) {
        print("No state change... (current state: " + (newSwitchState ? "on" : "off") + ")");
        return;
    }

    if (CONFIG.debugMode) {
        print("Debug mode on, simulating changing switch(es) to: " + (newSwitchState ? "on" : "off"));
        debugSwitchState = newSwitchState;
    } else {
        for (let i = 0; i < CONFIG.switches; i++) {
            print("Changing switch " + i + " to: " + (newSwitchState ? "on" : "off"));
            sendRequest(
                "Switch.Set",
                {
                    id: CONFIG.switchId + i,
                    on: newSwitchState,
                },
                function (response, errorCode, errorMessage) {
                    if (errorCode !== 0) {
                        print(errorMessage);
                        return;
                    }
                }
            );
        }
    }
}

function setColor() {
    if (CONFIG.colorMode) {
        let percent = Math.round(100 * (prices[date.hour] - min) / (max - min));
        let interval = 100 / CONFIG.colors.length;
        let color = "0%2c0%2c100";
        for (let i = 0; i < CONFIG.colors.length; i++) {
            if (percent >= (i * interval)) {
                color = CONFIG.colors[i];
            }
        }
        if (prices[date.hour] <= CONFIG.alwaysOnMaxPrice) {
            color = CONFIG.colors[0];
            print("Price below alwaysOnMaxPrice, setting color to rgb: " + color);
        } /* else if (prices[date.hour] >= CONFIG.alwaysOffMinPrice) {
            color = CONFIG.colors[CONFIG.colors.length - 1];
            print("Price above alwaysOffMinPrice, setting color to rgb: " + color);
        } */ else {
            print("Setting color to rgb: " + color);
        }
        
        var colorConfig="http://localhost/rpc/PLUGS_UI.SetConfig?config=%7B%22leds%22%3A%7B%22colors%22%3A%7B%22switch%3A0%22%3A%7B%22off%22%3A%7B%22brightness%22%3A20%2C%22rgb%22%3A%5B"+color+"%5D%7D%2C%22on%22%3A%7B%22brightness%22%3A30%2C%22rgb%22%3A%5B"+color+"%5D%7D%7D%7D%7D%7D";
        sendRequest(
            "http.get",
             {
               url: colorConfig
             },
            function (response, errorCode, errorMessage) {
                if (errorCode !== 0) {
                    print(errorMessage);
                    return;
                }
                print(JSON.stringify(response));
            }
        );
    }
}

function epochToDate(epochTimeIn, timezone, daylightSavingTime) {
    let secondsInMinute = 60;
    let secondsInHour = secondsInMinute * 60;
    let secondsInDay = secondsInHour * 24;
    let daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let secondsInYear = 0;
    let lseconds = 0;
    let epochTime = epochTimeIn + (timezone * secondsInHour);
    let dayOfWeek = (Math.floor(epochTime / secondsInDay) + 4) % 7;
    let daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

    for (let i = 0; i < 12; i++) {
        secondsInYear += daysInMonth[i] * secondsInDay;
    }

    let years = Math.floor(epochTime / secondsInYear) + 1970;
    for (let i = 1970; i < years; i++) {
        lseconds += i % 400 === 0 || (i % 100 !== 0 && i % 4 === 0) ? secondsInDay : 0;
    }

    let remainder = (epochTime % secondsInYear) - lseconds;
    if (remainder < 0) {
        years--;
        remainder += secondsInYear;
        remainder += ((years % 400 === 0 || (years % 100 !== 0 && years % 4 === 0)) ? secondsInDay : 0);
    }

    let leap = years % 400 === 0 || (years % 100 !== 0 && years % 4 === 0);
    let months = 0;
    while (remainder >= (daysInMonth[months] * secondsInDay) + (months === 1 && leap ? secondsInDay : 0)) {
        remainder -= (daysInMonth[months] * secondsInDay) + (months === 1 && leap ? secondsInDay : 0);
        months++;
    }

    let days = Math.floor(remainder / secondsInDay);
    //print("days")
    //print(days)
    remainder %= secondsInDay;

    if (daylightSavingTime && months >= 2 && months <= 9 && !(months === 2 && (dayOfWeek + 31 - days) > 7) && !(months === 9 && (dayOfWeek + 31 - days) < 7)) {
        return epochToDate(epochTimeIn, timezone + 1, false);
    }

    let hours = Math.floor(remainder / secondsInHour);
    remainder %= secondsInHour;

    let minutes = Math.floor(remainder / secondsInMinute);
    let seconds = remainder % secondsInMinute;
    let tz = timezone === 0 ? "Z" : timezone > 9 ? ("+" + JSON.stringify(timezone) + "00") : timezone > 0 ? ("+0" + JSON.stringify(timezone) + "00") : timezone < -9 ? (JSON.stringify(timezone) + "00") : ("-0" + JSON.stringify(Math.abs(timezone)) + "00");
    return {
        epoch: epochTimeIn,
        year: years,
        yearStr: JSON.stringify(years),
        month: months + 1,
        monthStr: (months + 1 < 10 ? "0" : "") + JSON.stringify(months + 1),
        day: days + 1,
        dayStr: (days + 1 < 10 ? "0" : "") + JSON.stringify(days + 1),
        hour: hours,
        hourStr: (hours + 1 < 10 ? "0" : "") + JSON.stringify(hours),
        minute: minutes,
        minuteStr: (minutes + 1 < 10 ? "0" : "") + JSON.stringify(minutes),
        second: seconds,
        secondStr: (seconds + 1 < 10 ? "0" : "") + JSON.stringify(seconds),
        dayOfWeek: dayOfWeek,
        dayOfWeekName: daysOfWeek[dayOfWeek],
        date: JSON.stringify(years) + "-" + (months + 1 < 10 ? "0" : "") + JSON.stringify(months + 1) + "-" + (days + 1 < 10 ? "0" : "") + JSON.stringify(days + 1) + "T" + (hours + 1 < 10 ? "0" : "") + JSON.stringify(hours) + ":" + (minutes + 1 < 10 ? "0" : "") + JSON.stringify(minutes) + ":" + (seconds + 1 < 10 ? "0" : "") + JSON.stringify(seconds) + tz,
    };
}

start();