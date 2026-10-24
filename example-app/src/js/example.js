import { CodePush } from 'capacitor-code-push';

window.testEcho = () => {
    const inputValue = document.getElementById("echoInput").value;
    CodePush.echo({ value: inputValue })
}
