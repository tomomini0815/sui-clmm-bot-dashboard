import boxen from 'boxen';
import chalk from 'chalk';
import ora, { Ora } from 'ora';

export class Logger {
  private static spinner: Ora | null = null;

  static info(msg: string) {
    if (this.spinner && this.spinner.isSpinning) this.spinner.stop();
    console.log(chalk.blue('ℹ'), chalk.white(msg));
  }

  static success(msg: string) {
    if (this.spinner && this.spinner.isSpinning) this.spinner.stop();
    console.log(chalk.green('✔'), chalk.greenBright(msg));
  }

  static warn(msg: string) {
    if (this.spinner && this.spinner.isSpinning) this.spinner.stop();
    console.log(chalk.yellow('⚠'), chalk.yellow(msg));
  }

  static error(msg: string, err?: any) {
    if (this.spinner && this.spinner.isSpinning) this.spinner.stop();
    console.log(chalk.red('✖'), chalk.redBright(msg));
    if (err) console.error(chalk.red(err.stack || err.toString()));
  }

  static startSpin(msg: string) {
    if (this.spinner && this.spinner.isSpinning) this.spinner.stop();
    this.spinner = ora({ text: chalk.cyan(msg), color: 'cyan' }).start();
  }

  static stopSpin(successMsg?: string) {
    if (this.spinner) {
      if (successMsg) {
        this.spinner.succeed(chalk.greenBright(successMsg));
      } else {
        this.spinner.stop();
      }
      this.spinner = null;
    }
  }

  static box(title: string, msg: string) {
    if (this.spinner && this.spinner.isSpinning) this.spinner.stop();
    console.log(
      boxen(chalk.white(msg), {
        title: chalk.bold.cyan(title),
        padding: 1,
        margin: 1,
        borderStyle: 'round',
        borderColor: 'cyan',
      })
    );
  }
}
